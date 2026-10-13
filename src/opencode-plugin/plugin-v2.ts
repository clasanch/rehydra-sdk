/**
 * Rehydra OpenCode Plugin — OpenCode 2 (V2 plugin API) implementation.
 *
 * OpenCode 2 replaces the V1 hooks-object entrypoint with a plugin definition
 * that exposes a stable `id` and registers hooks through a plugin context.
 * Mapping from the V1 hooks:
 *
 *   V1 hook                                V2 registration
 *   -------------------------------------- -----------------------------------------------------
 *   experimental.chat.messages.transform   ctx.session.hook("context" | "compaction" | "generate" | "title")
 *   experimental.chat.system.transform     same hooks — event.system.push({ type: "text", text })
 *   tool.execute.before                    ctx.tool.hook("execute.before") — mutate event.input in place
 *   tool.execute.after                     ctx.tool.hook("execute.after")  — event.result / event.status
 *   experimental.text.complete             no V2 equivalent (documented gap — see README)
 *   client.app.log                         console.* (captured by OpenCode's log service)
 *
 * The V2 session-request event shape (@opencode/ai SessionRequest) differs from
 * V1: { sessionID, system, messages: Message[] } where each Message has a role
 * and content parts. Text/reasoning parts carry `text`; tool-call parts carry
 * `input`; tool-result parts carry `result`. Tool calls and results share the
 * same `id` across messages, which is used to pair VCS commands with outputs.
 *
 * Registering the scrubber on all four session-request kinds also protects the
 * session-title request, closing the V1 title leak (OpenCode issue #46115)
 * without disabling the title agent.
 *
 * Structural types only: the plugin declares its own minimal shapes for the
 * OpenCode plugin context, so there is no runtime (or build) dependency on
 * OpenCode packages.
 */

/* eslint-disable no-console */

import { createAnonymizer } from "../core/anonymizer.js";
import { AnonymizerSessionImpl } from "../storage/session-base.js";
import { InMemoryPIIStorageProvider } from "../storage/in-memory.js";
import { InMemoryKeyProvider } from "../crypto/index.js";
import {
  PIIType,
  createDefaultPolicy,
  SECRET_PII_TYPES,
  DEFAULT_TAG_FORMAT,
} from "../types/index.js";
import type { AnonymizationPolicy } from "../types/index.js";
import type { PIITypeName, RehydraPluginOptions } from "./types.js";
import { buildPIISystemInstruction } from "../proxy/system-instruction.js";
import { buildTagPrefix } from "../utils/regex.js";
import { githubUsernameRecognizer } from "./github-username.js";
import { protectIdentityTags } from "./identity-recognizer.js";
import { vcsCommandTypes } from "./vcs-command.js";
import { gitIdentityRecognizer } from "./git-identity.js";
import { deepRehydrate } from "./plugin.js";

/** Session request kinds that can be hooked in OpenCode 2. */
const REQUEST_KINDS: readonly ["context", "compaction", "generate", "title"] = [
  "context",
  "compaction",
  "generate",
  "title",
] as const;

/** Minimal structural shape of the parts the scrubber edits. */
interface ContentPartStub {
  type: string;
  text?: string | null;
  id?: string;
  input?: unknown;
  result?: unknown;
  [key: string]: unknown;
}

/** Minimal structural shape of @opencode/ai Message. */
interface MessageStub {
  role: string;
  content?: unknown;
}

/** Minimal structural shape of @opencode/ai SessionRequest as delivered to hooks. */
interface SessionRequestEventStub {
  readonly sessionID: string;
  readonly system: Array<{ type: string; text: string }>;
  readonly messages: MessageStub[];
  [key: string]: unknown;
}

interface ToolExecuteBeforeEventStub {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  input: unknown;
}

interface ToolExecuteAfterEventStub {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly status: "completed" | "error";
  result?: unknown;
}

/**
 * The part of the OpenCode 2 plugin context this plugin uses. The real context
 * (@opencode/plugin Context) satisfies this structurally.
 */
export interface RehydraV2PluginContext {
  readonly app: { readonly name: string; readonly version: string };
  readonly location: { readonly directory: string; readonly project?: unknown };
  readonly options: Record<string, unknown>;
  readonly session: {
    hook(
      name: string,
      callback: (event: unknown) => void | Promise<void>,
    ): Promise<unknown>;
  };
  readonly tool: {
    hook(
      name: string,
      callback: (event: unknown) => void | Promise<void>,
    ): Promise<unknown>;
  };
}

export type RehydraCleanup = () => void | Promise<void>;

/** Default-exported plugin definition consumed by OpenCode 2. */
export interface RehydraV2Plugin {
  readonly id: string;
  readonly setup: (
    context: RehydraV2PluginContext,
  ) => Promise<RehydraCleanup | void>;
}

export function isVcsEnabled(
  options: RehydraPluginOptions | undefined,
): boolean {
  return options?.vcsIdentities === true;
}

/**
 * Creates a Rehydra plugin definition for OpenCode 2.
 *
 * @example
 * ```json
 * // opencode.json — published npm package with default options
 * { "plugins": ["@rehydra/opencode"] }
 * ```
 *
 * @example
 * ```json
 * // opencode.json — npm package with custom options
 * {
 *   "plugins": [{
 *     "package": "@rehydra/opencode",
 *     "options": { "envFiles": [".env", ".env.local"] }
 *   }]
 * }
 * ```
 *
 * @example
 * ```typescript
 * // .opencode/plugins/rehydra.ts — local plugin with custom options
 * import { createRehydraPluginV2 } from "@rehydra/opencode";
 * export default createRehydraPluginV2({
 *   envFiles: [".env", ".env.local"],
 * });
 * ```
 */
export function createRehydraPluginV2(
  options?: RehydraPluginOptions,
): RehydraV2Plugin {
  return {
    id: "rehydra",
    async setup(ctx): Promise<RehydraCleanup | void> {
      const SERVICE = "rehydra";

      // OpenCode 2 removes client.app.log from the plugin context. Plain console
      // output is captured by OpenCode's log service, so the structured
      // "service=rehydra …" entries survive in the log directory.
      function log(
        level: "debug" | "info" | "warn" | "error",
        message: string,
        extra?: Record<string, unknown>,
      ): void {
        const payload: Record<string, unknown> = {
          service: SERVICE,
          level,
          message,
        };
        if (extra !== undefined) {
          for (const [key, value] of Object.entries(extra)) {
            payload[key] = value;
          }
        }
        if (level === "error") {
          console.error(payload);
        } else if (level === "warn") {
          console.warn(payload);
        } else {
          console.log(payload);
        }
      }

      const keyProvider = new InMemoryKeyProvider();
      const piiStorage = new InMemoryPIIStorageProvider();

      // Factory options take precedence over options from opencode.json
      // (ctx.options). Both feed the same RehydraPluginOptions shape.
      const runtimeOptions = ctx.options as RehydraPluginOptions | undefined;
      const opts: RehydraPluginOptions = {
        ...(runtimeOptions ?? {}),
        ...(options ?? {}),
      };

      // Build anonymizer config from options, sharing key and storage providers
      const baseConfig = opts.anonymizer ?? {
        secrets: {
          enabled: true,
          envFiles: opts.envFiles ?? ["**/.env*"],
          redactValues: opts.redactValues,
          minValueLength: opts.minValueLength,
        },
      };

      const anonymizerConfig = {
        ...baseConfig,
        secrets:
          baseConfig.secrets === undefined
            ? undefined
            : {
                ...baseConfig.secrets,
                envBaseDirectory:
                  baseConfig.secrets.envBaseDirectory ?? ctx.location.directory,
              },
      };

      const tagFormat =
        anonymizerConfig.tagFormat ?? opts.tagFormat ?? DEFAULT_TAG_FORMAT;
      const tagPrefix = buildTagPrefix(tagFormat);
      const rehydraInstruction = `<rehydra>\n${buildPIISystemInstruction(tagFormat)}\n</rehydra>`;

      const anonymizer = createAnonymizer({
        ...anonymizerConfig,
        tagFormat,
        keyProvider,
        piiStorageProvider: piiStorage,
      });
      if (opts.vcsIdentities === true) {
        anonymizer
          .getRegistry()
          .register(protectIdentityTags(githubUsernameRecognizer, tagFormat));
        anonymizer
          .getRegistry()
          .register(protectIdentityTags(gitIdentityRecognizer, tagFormat));
      }
      await anonymizer.initialize();

      // Build policy with disabled types (URL and IP_ADDRESS disabled by default)
      const disableTypes: PIITypeName[] = opts.disableTypes ?? [
        "URL",
        "IP_ADDRESS",
      ];
      let policy: Partial<AnonymizationPolicy> | undefined = opts.policy;
      if (disableTypes.length > 0) {
        const base = createDefaultPolicy();
        const disableSet = new Set<string>(disableTypes);
        const regexEnabledTypes = new Set(base.regexEnabledTypes);
        const nerEnabledTypes = new Set(base.nerEnabledTypes);
        // createDefaultPolicy() excludes secret types (they're opt-in via
        // AnonymizerConfig.secrets).  Add them back so that passing this
        // partial policy to mergePolicyWithBase doesn't accidentally drop
        // the secret types the anonymizer added to its internal default.
        for (const secretType of SECRET_PII_TYPES) {
          regexEnabledTypes.add(secretType);
        }
        for (const t of disableSet) {
          const piiType = t as PIIType;
          regexEnabledTypes.delete(piiType);
          nerEnabledTypes.delete(piiType);
        }
        policy = {
          ...policy,
          regexEnabledTypes,
          nerEnabledTypes,
        };
      }

      log("info", "plugin initialized", {
        envFiles: anonymizerConfig.secrets?.envFiles,
        redactValueCount: opts.redactValues?.length ?? 0,
        disableTypes,
        opencode: `${ctx.app.name} ${ctx.app.version}`,
      });

      const locale = opts.locale;
      const identityPolicy = (
        types: PIIType[],
      ): Partial<AnonymizationPolicy> => {
        const defaults = createDefaultPolicy();
        const configPolicy = anonymizerConfig.defaultPolicy;
        const enabledTypes = new Set(
          policy?.enabledTypes ??
            configPolicy?.enabledTypes ??
            defaults.enabledTypes,
        );
        const regexEnabledTypes = new Set(
          policy?.regexEnabledTypes ??
            configPolicy?.regexEnabledTypes ??
            defaults.regexEnabledTypes,
        );
        if (anonymizerConfig.secrets?.enabled === true) {
          for (const type of SECRET_PII_TYPES) {
            if (!disableTypes.includes(type)) {
              enabledTypes.add(type);
              regexEnabledTypes.add(type);
            }
          }
        }
        for (const type of types) {
          if (!disableTypes.includes(type)) {
            enabledTypes.add(type);
            regexEnabledTypes.add(type);
          }
        }
        return {
          ...policy,
          enabledTypes,
          regexEnabledTypes,
          reuseIdsForRepeatedPII: true,
        };
      };

      // One session per OpenCode session, keyed by sessionID
      const sessions = new Map<string, AnonymizerSessionImpl>();

      function getSession(sessionID: string): AnonymizerSessionImpl {
        let session = sessions.get(sessionID);
        if (session === undefined) {
          session = new AnonymizerSessionImpl(
            anonymizer,
            sessionID,
            piiStorage,
            keyProvider,
          );
          sessions.set(sessionID, session);
        }
        return session;
      }

      // Track whether any anonymization occurred (to conditionally inject instruction)
      let hasAnonymized = false;

      /**
       * Scrubs one outgoing model request. OpenCode 2 delivers the same request
       * shape to the `context` (agent loop), `compaction`, `generate`, and
       * `title` session hooks, so one implementation covers every kind.
       */
      async function scrubRequest(
        event: SessionRequestEventStub,
      ): Promise<void> {
        let totalScrubbed = 0;
        const scrubbedByType: Record<string, number> = {};
        const session = getSession(event.sessionID);

        // VCS commands by tool-call id, captured before scrubbing so detection
        // tokens survive anonymization. Tool results pair with their call by id.
        const commandsByCallId = new Map<string, string>();

        // OpenCode retains the rehydrated arguments after tool execution and
        // serializes them into later model requests. Copy and scrub values so
        // the execution arguments and JSON property names stay intact.
        const scrubValue = async (
          value: unknown,
          activePolicy?: Partial<AnonymizationPolicy>,
        ): Promise<unknown> => {
          if (typeof value === "string") {
            const result = await session.anonymize(
              value,
              locale,
              activePolicy ?? policy,
            );
            if (result.stats.totalEntities > 0) {
              hasAnonymized = true;
              totalScrubbed += result.stats.totalEntities;
              for (const [type, count] of Object.entries(
                result.stats.countsByType,
              )) {
                scrubbedByType[type] = (scrubbedByType[type] ?? 0) + count;
              }
            }
            return result.anonymizedText;
          }
          if (Array.isArray(value)) {
            const result: unknown[] = [];
            for (const item of value)
              result.push(await scrubValue(item, activePolicy));
            return result;
          }
          if (value !== null && typeof value === "object") {
            const entries: Array<[string, unknown]> = [];
            for (const [key, item] of Object.entries(value)) {
              entries.push([key, await scrubValue(item, activePolicy)]);
            }
            return Object.fromEntries(entries);
          }
          return value;
        };

        for (const msg of event.messages) {
          const content = msg.content;
          if (!Array.isArray(content)) continue;

          for (const part of content as ContentPartStub[]) {
            if (part.type === "tool-call") {
              const rawInput = part.input;
              if (
                isVcsEnabled(opts) &&
                rawInput !== null &&
                typeof rawInput === "object" &&
                typeof (rawInput as { command?: unknown }).command ===
                  "string" &&
                typeof part.id === "string"
              ) {
                commandsByCallId.set(
                  part.id,
                  (rawInput as { command: string }).command,
                );
              }
              part.input = await scrubValue(part.input);
            } else if (part.type === "text" || part.type === "reasoning") {
              if (typeof part.text === "string") {
                part.text = (await scrubValue(part.text)) as string;
              }
            } else if (
              part.type === "tool-result" &&
              part.result !== undefined &&
              part.result !== null
            ) {
              let outputPolicy: Partial<AnonymizationPolicy> | undefined;
              if (
                isVcsEnabled(opts) &&
                typeof part.id === "string" &&
                commandsByCallId.has(part.id)
              ) {
                const command = commandsByCallId.get(part.id) ?? "";
                const commands = vcsCommandTypes(command);
                const types: PIIType[] = [];
                if (commands.has("github")) types.push(PIIType.GITHUB_USERNAME);
                if (commands.has("git")) types.push(PIIType.PERSON);
                if (types.length > 0) outputPolicy = identityPolicy(types);
              }
              part.result = await scrubValue(part.result, outputPolicy);
            }
          }
        }

        if (totalScrubbed > 0) {
          // Only include types that actually had hits
          const nonZero: Record<string, number> = {};
          for (const [type, count] of Object.entries(scrubbedByType)) {
            if (count > 0) nonZero[type] = count;
          }
          log("info", `scrubbed ${totalScrubbed} secret(s) from messages`, {
            scrubbed: nonZero,
            messageCount: event.messages.length,
          });
        } else {
          log("debug", "no secrets found in messages", {
            messageCount: event.messages.length,
          });
        }

        if (hasAnonymized) {
          log("debug", "injected rehydra instruction into system prompt");
          event.system.push({ type: "text", text: rehydraInstruction });
        }
      }

      // Register the scrubber on every model-request kind OpenCode 2 can issue:
      // agent loop, checkpoint compaction, transient generates, session titles.
      for (const kind of REQUEST_KINDS) {
        await ctx.session.hook(kind, (event) =>
          scrubRequest(event as SessionRequestEventStub),
        );
      }

      await ctx.tool.hook("execute.before", async (event) => {
        const toolEvent = event as ToolExecuteBeforeEventStub;
        const session = getSession(toolEvent.sessionID);
        const before = JSON.stringify(toolEvent.input);
        toolEvent.input = await deepRehydrate(
          toolEvent.input,
          session,
          tagPrefix,
        );
        if (before !== JSON.stringify(toolEvent.input)) {
          log("info", "rehydrated PII tags in tool args", {
            tool: toolEvent.tool,
            callID: toolEvent.id,
          });
        }
      });

      // Result shape varies by tool type: native tools return their result
      // object while MCP tools return the raw CallToolResult
      // ({ content: [{type,text}], … }). deepRehydrate handles any shape.
      await ctx.tool.hook("execute.after", async (event) => {
        if ((event as ToolExecuteAfterEventStub).status === "error") return;
        const toolEvent = event as ToolExecuteAfterEventStub;
        const session = getSession(toolEvent.sessionID);
        const before = JSON.stringify(toolEvent.result);
        toolEvent.result = await deepRehydrate(
          toolEvent.result,
          session,
          tagPrefix,
        );
        if (JSON.stringify(toolEvent.result) !== before) {
          log("info", "rehydrated PII tags in tool result", {
            tool: toolEvent.tool,
            callID: toolEvent.id,
          });
        }
      });

      // Drop the PII maps when the plugin unloads.
      return () => {
        sessions.clear();
        piiStorage.clear();
      };
    },
  };
}

export default createRehydraPluginV2();