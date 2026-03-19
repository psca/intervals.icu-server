import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";

// Vite plugin to alias cloudflare:* built-ins to local stubs so vitest
// (Node.js) can import @cloudflare/workers-oauth-provider without the CF runtime.
const cloudflareBuiltinsPlugin: Plugin = {
  name: "cloudflare-builtins",
  resolveId(id) {
    if (id === "cloudflare:workers") {
      return new URL("./test/__mocks__/cloudflare-workers.ts", import.meta.url).pathname;
    }
    return undefined;
  },
};

export default defineConfig({
  plugins: [cloudflareBuiltinsPlugin],
  test: {
    server: {
      deps: {
        // Run oauth provider through Vite (not Node native ESM loader)
        // so our cloudflare: alias plugin can intercept cloudflare:workers.
        inline: ["@cloudflare/workers-oauth-provider"],
      },
    },
  },
});
