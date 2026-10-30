#!/usr/bin/env node
import { Command, CommanderError, Help, Option } from "commander";
import { fileURLToPath } from "node:url";
import * as auth from "./commands/auth";
import * as billing from "./commands/billing";
import * as brands from "./commands/brands";
import * as chat from "./commands/chat";
import * as cleanup from "./commands/cleanup";
import * as configCommand from "./commands/config";
import * as connections from "./commands/connections";
import * as dashboards from "./commands/dashboards";
import * as evalCommand from "./commands/eval";
import * as feedback from "./commands/feedback";
import * as instructions from "./commands/instructions";
import * as init from "./commands/init";
import * as installSkill from "./commands/installSkill";
import * as issues from "./commands/issues";
import * as keys from "./commands/keys";
import * as localRuntime from "./commands/localRuntime";
import * as mcp from "./commands/mcp";
import * as members from "./commands/members";
import * as models from "./commands/models";
import * as localProfiles from "./commands/localProfiles";
import * as onboard from "./commands/onboard";
import * as optimizations from "./commands/optimizations";
import * as org from "./commands/org";
import * as orgs from "./commands/orgs";
import * as personas from "./commands/personas";
import * as preference from "./commands/preference";
import * as query from "./commands/query";
import * as repos from "./commands/repos";
import * as run from "./commands/run";
import * as skills from "./commands/skills";
import * as stats from "./commands/stats";
import * as status from "./commands/status";
import * as tags from "./commands/tags";
import * as telemetry from "./commands/telemetry";
import * as update from "./commands/update";
import * as usage from "./commands/usage";
import {
  commandPath,
  type ErrorContext,
  errorReport,
  renderError,
  wantsJson,
} from "./lib/errors";
import { readGaugeState } from "./lib/gaugeState";
import { OUTPUT_FORMATS } from "./lib/output";
import { formatCommandHelp, formatRootHelp } from "./lib/rootHelp";
import { rejectUnknownCommandHelp } from "./lib/unknownCommand";
import { CLI_VERSION } from "./version";
import { registerTelemetry } from "./lib/telemetry";

const program = new Command();

program
  .name("gauge")
  .description(
    "Hillclimb Agent Experience: run coding agents against your product, analyze friction, improve, and retest. Run locally with Docker and your agent credentials, or use hosted Gauge. Agents: start with `gauge instructions`.",
  )
  .configureHelp({
    showGlobalOptions: true,
    formatHelp: (cmd, helper) =>
      cmd === program
        ? formatRootHelp(cmd, helper)
        : formatCommandHelp(cmd, helper),
  })
  .version(CLI_VERSION)
  .option(
    "--org <org>",
    "organization slug or id, for Gauge Chat and Gauge Agents (default: gauge.json orgId, then your saved default)",
  )
  .addOption(
    new Option("-o, --output <format>", "output format")
      .choices([...OUTPUT_FORMATS])
      .default("table"),
  )
  .addOption(
    new Option("--local", "run on this machine, no account needed").conflicts(
      "hosted",
    ),
  )
  .option(
    "--hosted",
    "run on hosted Gauge (needs an account). Default: workspace preference, then user preference, else local",
  );

program.exitOverride();
rejectUnknownCommandHelp(program);
program.configureOutput({ outputError: () => {} });

for (const group of [
  instructions,
  localRuntime,
  cleanup,
  update,
  auth,
  init,
  installSkill,
  onboard,
  status,
  orgs,
  org,
  members,
  models,
  localProfiles,
  run,
  evalCommand,
  preference,
  personas,
  skills,
  mcp,
  connections,
  repos,
  optimizations,
  brands,
  tags,
  issues,
  dashboards,
  keys,
  billing,
  usage,
  stats,
  query,
  chat,
  configCommand,
  telemetry,
  feedback,
]) {
  group.register(program);
}

if (!import.meta.url.endsWith(".ts"))
  registerTelemetry(
    program,
    fileURLToPath(new URL("./telemetryWorker.js", import.meta.url)),
  );

function errorContext(): ErrorContext {
  try {
    const state = readGaugeState(program.opts());
    return { local: state.mode === "local" ? state.source : undefined };
  } catch {
    return {};
  }
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (
    error instanceof CommanderError &&
    (error.exitCode === 0 ||
      error.code === "commander.help" ||
      error.code === "commander.helpDisplayed")
  )
    process.exit(error.exitCode === 0 ? 0 : 2);
  const argv = process.argv.slice(2);
  const report = errorReport(error, commandPath(program, argv), errorContext());
  if (
    report.code === "upgrade_required" &&
    !/npm install/i.test(report.message)
  )
    report.hint = "Run: npm install -g @withgauge/cli";
  if (
    report.code === "not_found" &&
    /organization/i.test(report.message) &&
    !program.opts().org
  )
    report.hint =
      "That is your configured default organization. Run `gauge orgs list` to see yours, then `gauge orgs use <org>` to update it.";
  process.stderr.write(renderError(report, wantsJson(argv)));
  process.exit(report.exitCode);
}
