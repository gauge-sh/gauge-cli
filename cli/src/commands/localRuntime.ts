import type { Command } from "commander";
import { resolveOutput } from "../lib/context";
import { inspectLocalRuntime, inspectLocalGateway, pullLocalRuntime, pullLocalGateway, type RuntimeInspection } from "../lib/localRuntime";
import { printJson } from "../lib/output";

function print(result: RuntimeInspection & { gateway: RuntimeInspection }, command: Command): void {
  if (resolveOutput(command) === "json") printJson(result);
  else {
    console.log(`Runtime: ${result.reference}`);
    if (result.imageId) console.log(`Image ID: ${result.imageId}`);
    if (result.repoDigest) console.log(`Registry digest: ${result.repoDigest}`);
    console.log(`Status: ${result.ready ? "ready" : result.problem?.code}`);
    if (result.platform) console.log(`Platform: ${result.platform}`);
    if (result.problem) console.log(`${result.problem.message}\n${result.problem.hint}`);
    console.log(`Gateway: ${result.gateway.reference} (${result.gateway.ready ? "ready" : result.gateway.problem?.code})`);
    if (result.gateway.problem) console.log(`${result.gateway.problem.message}\n${result.gateway.problem.hint}`);
  }
  if (!result.ready || !result.gateway.ready) process.exitCode = 1;
}

export function register(program: Command): void {
  const local = program.commands.find((command) => command.name() === "local")
    ?? program.command("local").description("Configure local execution (no Gauge account needed)");
  const runtime = local.command("runtime").description("Inspect or download the supported Docker runtime");
  runtime.command("inspect").description("Report local runtime availability and compatibility without downloading")
    .action((_options: unknown, command: Command) => print({ ...inspectLocalRuntime(), gateway: inspectLocalGateway() }, command));
  runtime.command("pull").description("Download the CLI's supported public runtime image")
    .action(async (_options: unknown, command: Command) => print({ ...await pullLocalRuntime(), gateway: await pullLocalGateway() }, command));
}
