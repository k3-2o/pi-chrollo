import { defineConfig } from "vitest/config";

export default defineConfig({
  // src/ modules import each other as "./x.js" (tsx convention). Vite resolves
  // the .js literally, so strip it to let it find the .ts source.
  resolve: {
    alias: [{ find: /^(\.{1,2}\/.*)\.js$/, replacement: "$1" }],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10000,
  },
});
