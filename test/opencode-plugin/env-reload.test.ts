/**
 * Tests for picking up new and changed .env secrets without restarting
 * OpenCode (issue #107).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAnonymizer, PIIType } from "../../src/index.js";
import { createRehydraPlugin } from "../../src/opencode-plugin/plugin.js";
import { createRehydraPluginV2 } from "../../src/opencode-plugin/plugin-v2.js";
import type { RehydraPluginOptions } from "../../src/opencode-plugin/types.js";

let directory: string;
async function writeEnv(path: string, content: string): Promise<void> {
  const full = join(directory, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function v1Scrubber(options: RehydraPluginOptions): Promise<(text: string) => Promise<string>> {
  const hooks = (await createRehydraPlugin(options)({
    directory, worktree: directory,
    client: { app: { log: async () => {} } },
  })) as Record<string, (...args: unknown[]) => Promise<void>>;
  return async (text) => {
    const part = { type: "text", text };
    await hooks["experimental.chat.messages.transform"]!({}, {
      messages: [{ info: { sessionID: "env-reload", role: "user" }, parts: [part] }],
    });
    return part.text;
  };
}

beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "rehydra-env-reload-")); });
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

describe("Anonymizer.reloadSecrets", () => {
  it("picks up added and changed values and drops removed ones", async () => {
    await writeEnv(".env", "TOKEN=first-secret-value\n");
    const anonymizer = createAnonymizer({
      ner: { mode: "disabled" },
      secrets: { enabled: true, envFiles: ["**/.env*"], envBaseDirectory: directory },
    });
    await anonymizer.initialize();
    const scrub = async (text: string): Promise<string> => (await anonymizer.anonymize(text)).anonymizedText;
    expect(await scrub("first-secret-value")).toContain("ENV_VAR_SECRET");
    expect(await anonymizer.reloadSecrets()).toBe(false);

    const recognizerCount = anonymizer.getRegistry().getRecognizers(PIIType.ENV_VAR_SECRET).length;
    await writeEnv(".env", "TOKEN=second-secret-value\n");
    await writeEnv("packages/api/.env.local", "OTHER=third-secret-value\n");

    expect(await anonymizer.reloadSecrets()).toBe(true);
    expect(await scrub("first-secret-value")).toBe("first-secret-value");
    expect(await scrub("second-secret-value third-secret-value")).not.toMatch(/second|third/);
    expect(anonymizer.getRegistry().getRecognizers(PIIType.ENV_VAR_SECRET)).toHaveLength(recognizerCount);
  });
});

describe("plugin env file reloading", () => {
  it("picks up secrets added to .env without restarting", async () => {
    await writeEnv(".env", "TOKEN=first-secret-value\n");
    const scrub = await v1Scrubber({ envRefreshInterval: 0 });
    expect(await scrub("new-secret-value")).toBe("new-secret-value");

    await writeEnv(".env", "TOKEN=first-secret-value\nNEW_TOKEN=new-secret-value\n");
    expect(await scrub("new-secret-value")).toContain("ENV_VAR_SECRET");
  });

  it("waits envRefreshInterval between checks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const scrub = await v1Scrubber({ envRefreshInterval: 60_000 });
    await writeEnv(".env", "TOKEN=new-secret-value\n");
    expect(await scrub("new-secret-value")).toBe("new-secret-value");

    vi.setSystemTime(Date.now() + 60_000);
    expect(await scrub("new-secret-value")).toContain("ENV_VAR_SECRET");
  });

  it("loads env files only at startup when envRefreshInterval is false", async () => {
    const scrub = await v1Scrubber({ envRefreshInterval: false });
    await writeEnv(".env", "TOKEN=new-secret-value\n");
    expect(await scrub("new-secret-value")).toBe("new-secret-value");
  });

  it("reloads env files before OpenCode 2 requests", async () => {
    const hooks = new Map<string, (event: unknown) => void | Promise<void>>();
    const register = async (name: string, callback: (event: unknown) => void | Promise<void>): Promise<unknown> => {
      hooks.set(name, callback);
      return { dispose: async (): Promise<void> => {} };
    };
    await createRehydraPluginV2().setup({
      app: { name: "opencode", version: "2.0.30" },
      location: { directory },
      options: { envRefreshInterval: 0 },
      session: { hook: register },
      tool: { hook: register },
    });

    await writeEnv(".env", "TOKEN=new-secret-value\n");
    const part = { type: "text", text: "new-secret-value" };
    await hooks.get("context")!({
      sessionID: "env-reload", system: [], messages: [{ role: "user", content: [part] }],
    });
    expect(part.text).toContain("ENV_VAR_SECRET");
  });
});
