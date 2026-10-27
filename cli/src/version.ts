import { createRequire } from "node:module";

export const CLI_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

export const USER_AGENT = `gauge-cli/${CLI_VERSION}`;
