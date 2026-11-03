import { readFileSync, statSync } from "node:fs";
import {
  CLI_RULE_LIMITS,
  cliRuleAuthorInputSchema,
} from "@withgauge/api-schemas/cli-rules";
import { CliError } from "./client";

/** Read once before confirmation/uploads so a launch uses the validated bytes. */
export function readCliRules(path: string) {
  if (path === "-")
    throw new CliError(
      "usage",
      "--cli-rules expects a JSON file path, not stdin",
    );
  try {
    const info = statSync(path);
    if (!info.isFile()) throw new Error("Expected a regular JSON file");
    if (info.size > CLI_RULE_LIMITS.bundleBytes)
      throw new Error("CLI rules file exceeds 2 MiB");
    return cliRuleAuthorInputSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    );
  } catch (error) {
    throw new CliError(
      "usage",
      `Invalid --cli-rules file: ${error instanceof Error ? error.message : error}`,
    );
  }
}
