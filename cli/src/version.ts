import { createRequire } from "node:module";

export const CLI_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
