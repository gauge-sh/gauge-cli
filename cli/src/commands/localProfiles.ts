import type { Command } from "commander";
import { CliError } from "../lib/client";
import { resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { inspectLocalCredential, LOCAL_TARGETS, readProfiles, requireProfile, setProfile, writeProfiles } from "../lib/localProfiles";

export function register(program: Command): void {
  const local = program.commands.find((command) => command.name() === "local") ?? program.command("local").description("Configure local execution");
  const profiles = local.command("profiles").description("Manage local agent credentials (references only; separate from Gauge account login)");
  profiles.command("list").description("List profiles and per-harness defaults; never print secrets")
    .action((_opts: unknown, cmd: Command) => {
      const store = readProfiles();
      printItems(Object.entries(store.profiles).map(([name, p]) => ({ name, ...p, active: store.defaults[p.agent] === name })), resolveOutput(cmd));
    });
  profiles.command("set <profile>").description("Create a profile or update it with --replace; --env takes a variable name, never a secret")
    .requiredOption("--agent <agent>", "CLAUDE_CODE, CODEX_CLI, PI, or OPENCODE")
    .requiredOption("--provider <provider>", "anthropic, openai, openai-codex, fireworks, or openrouter")
    .requiredOption("--auth <mode>", "access_token (native login), api_key, or setup_token (Claude only)")
    .option("--env <variable>", "environment variable holding the key/token (defaults to the provider's standard variable)")
    .option("--replace", "replace an existing profile")
    .action((name: string, opts: { agent: string; provider: string; auth: string; env?: string; replace?: boolean }, cmd: Command) => {
      const { replace, ...profile } = opts;
      const store = setProfile(name, profile, replace);
      const result = { name, ...store.profiles[name], active: store.defaults[profile.agent] === name };
      if (resolveOutput(cmd) === "json") printJson(result);
      else console.log(`Saved profile ${name}. Select with gauge local profiles use ${name}, or gauge run --local --profile ${name}.`);
    });
  profiles.command("use <profile>").description("Set the default for this profile's harness")
    .action((name: string, _opts: unknown, cmd: Command) => {
      const store = readProfiles();
      const profile = requireProfile(store, name);
      store.defaults[profile.agent] = name;
      writeProfiles(store);
      if (resolveOutput(cmd) === "json") printJson({ agent: profile.agent, profile: name });
      else console.log(`${profile.agent} now uses ${name}.`);
    });
  profiles.command("remove <profile>").description("Remove a reference and its default selection; keep native logins and environment variables")
    .action((name: string, _opts: unknown, cmd: Command) => {
      const store = readProfiles();
      requireProfile(store, name);
      delete store.profiles[name];
      const cleared = Object.keys(store.defaults).filter((agent) => store.defaults[agent] === name);
      for (const agent of cleared) delete store.defaults[agent];
      writeProfiles(store);
      if (resolveOutput(cmd) === "json") printJson({ removed: name, clearedDefaults: cleared });
      else console.log(`Removed ${name}.${cleared.length ? ` ${cleared.join(", ")} now uses automatic credential discovery.` : ""}`);
    });
  profiles.command("inspect <profile>").description("Check local compatibility, credential availability and expiry; does not call the provider")
    .option("--model <model>", "check this model (default: the harness's default model)")
    .action(async (name: string, opts: { model?: string }, cmd: Command) => {
      const store = readProfiles();
      const p = requireProfile(store, name);
      if (!opts.model && (p.agent === "PI" || p.agent === "OPENCODE") && !LOCAL_TARGETS[p.agent].model.startsWith(`${p.provider}/`)) {
        throw new CliError("usage", `Specify --model ${p.provider}/<model> to inspect this profile.`, { hint: `The ${p.agent} default model uses a different provider. Choose a model available through ${p.provider}.` });
      }
      const result = await inspectLocalCredential(p.agent, opts.model ?? LOCAL_TARGETS[p.agent].model, { profile: name }, store);
      if (resolveOutput(cmd) === "json") printJson(result);
      else {
        console.log(`${name}: ${result.ready ? "ready locally" : "not ready"} for ${result.agent} ${result.model}`);
        if (result.profile) console.log(`Source: ${result.profile.source}; auth: ${result.profile.auth}`);
        if (result.expiresAt) console.log(`Expires: ${result.expiresAt}`);
        if (result.problem) console.log(result.problem);
        console.log("Local checks do not verify provider acceptance or model access.");
      }
      if (!result.ready) process.exitCode = 1;
    });
}
