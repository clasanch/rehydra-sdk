/**
 * Rehydra OpenCode Plugin
 * Anonymizes secrets in LLM context via OpenCode's native plugin hooks.
 */

import { createRehydraPlugin } from "./plugin.js";
import { createRehydraPluginV2 } from "./plugin-v2.js";

export { createRehydraPlugin } from "./plugin.js";
export { createRehydraPluginV2 } from "./plugin-v2.js";
export type { RehydraPluginOptions } from "./types.js";
export type {
  RehydraV2Plugin,
  RehydraV2PluginContext,
  RehydraCleanup,
} from "./plugin-v2.js";

/**
 * Dual V1/V2 default export.
 *
 * - OpenCode 2 reads the `id` and `setup()` members and ignores `server()`.
 * - OpenCode 1 object entrypoints (>= 1.18.29) call `server()` and use the
 *   returned V1 hooks.
 *
 * V1 releases older than 1.18.29 expect a function export; on those, import
 * `createRehydraPlugin()` (the callable factory) instead of using the default
 * export.
 */
const defaultV2Plugin = createRehydraPluginV2();

export default {
  id: defaultV2Plugin.id,
  setup: defaultV2Plugin.setup,
  async server(
    input?: Parameters<ReturnType<typeof createRehydraPlugin>>[0],
    options?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Deprecated V1 entrypoint. Fall back to a no-op client and the current
    // working directory when the harness calls `server()` without input.
    const resolved = input ?? {
      client: {
        app: { log: (): Promise<undefined> => Promise.resolve(undefined) },
      },
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    return await createRehydraPlugin()(resolved, options);
  },
};
