import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: { d1Databases: ["DB"] },
      wrangler: { configPath: "./wrangler.jsonc" }
    })
  ]
});
