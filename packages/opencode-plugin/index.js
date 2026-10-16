import {
  createRehydraPlugin,
  createRehydraPluginV2,
} from "rehydra/opencode-plugin";

// Named factories for custom config:
// - createRehydraPlugin  — OpenCode 1 (returns the callable V1 plugin)
// - createRehydraPluginV2 — OpenCode 2 (returns the { id, setup } definition)
// For OpenCode 2 with custom options prefer the config "options" form:
//   { "plugins": [{ "package": "@rehydra/opencode", "options": { ... } }] }
export { createRehydraPlugin, createRehydraPluginV2 };

// Named export for OpenCode 1: OpenCode calls named exports as plugin
// functions, so this must be the V1 Plugin itself (takes ctx, returns hooks).
export const rehydra = createRehydraPlugin();

// Default export: dual V1/V2 entrypoint.
// - OpenCode 2 reads `id` and `setup()`, ignoring `server()`.
// - OpenCode 1 (>= 1.18.29 object entrypoints) calls `server()` and uses the
//   returned hooks. V1 releases older than 1.18.29 should import `rehydra`.
const v2 = createRehydraPluginV2();
export default {
  id: v2.id,
  setup: v2.setup,
  async server(input) {
    const plugin = createRehydraPlugin();
    const resolved = input ?? {
      client: { app: { log: () => Promise.resolve(undefined) } },
      directory: process.cwd(),
      worktree: process.cwd(),
    };
    return await plugin(resolved);
  },
};
