import type { Command } from "commander";
import { CliError } from "../lib/client";
import {
  CONFIG_KEYS,
  type ConfigKey,
  configPath,
  readConfig,
  updateConfig,
} from "../lib/config";
import { printJson } from "../lib/output";

function assertKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as readonly string[]).includes(key)) {
    return key as ConfigKey;
  }
  throw new CliError(
    "usage",
    `Unknown config key '${key}'. Valid keys: ${CONFIG_KEYS.join(", ")}`,
  );
}

export function register(program: Command): void {
  const config = program
    .command("config")
    .description("Local client config (~/.config/gauge/config.json)");

  config
    .command("get [key]")
    .description("Print the whole config, or a single key's value")
    .action((key?: string) => {
      const current = readConfig();
      if (key === undefined) {
        printJson(current);
        return;
      }
      console.log(current[assertKey(key)] ?? "");
    });

  config
    .command("set <key> <value>")
    .description(`Set a config key (${CONFIG_KEYS.join(", ")})`)
    .action((key: string, value: string) => {
      const configKey = assertKey(key);
      if (configKey === "backend" && value !== "local" && value !== "hosted")
        throw new CliError("usage", "backend must be local or hosted");
      updateConfig({ [configKey]: value });
      console.log(`${configKey} = ${value} (${configPath()})`);
    });

  config
    .command("unset <key>")
    .description("Remove a config key")
    .action((key: string) => {
      const configKey = assertKey(key);
      updateConfig({ [configKey]: undefined });
      console.log(`${configKey} unset (${configPath()})`);
    });
}
