import type { RehydraPluginOptions } from "rehydra/opencode-plugin";

export type {
  RehydraPluginOptions,
  RehydraV2Plugin,
} from "rehydra/opencode-plugin";
export {
  createRehydraPlugin,
  createRehydraPluginV2,
} from "rehydra/opencode-plugin";

/**
 * OpenCode 1 plugin function (named export).
 * OpenCode 1 calls named exports as plugin functions.
 */
export declare const rehydra: (
  input: {
    client: unknown;
    directory: string;
    worktree: string;
    [key: string]: unknown;
  },
  options?: RehydraPluginOptions,
) => Promise<Record<string, unknown>>;

/**
 * Dual V1/V2 default entrypoint.
 * OpenCode 2 reads `id` + `setup()`; OpenCode 1 (>= 1.18.29) calls `server()`.
 */
declare const _default: {
  id: string;
  setup: (ctx: unknown) => Promise<void | (() => void)>;
  server: (input?: unknown, options?: RehydraPluginOptions) => Promise<Record<string, unknown>>;
};
export default _default;
