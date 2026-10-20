import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    batchWorker: "src/batchWorker.ts",
    telemetryWorker: "src/telemetryWorker.ts",
    worker: "../packages/local/dist/worker.js",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  esbuildOptions(options) {
    options.minifyWhitespace = true;
    options.legalComments = "eof";
  },
});
