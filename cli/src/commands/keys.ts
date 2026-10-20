import { keys, type ListResponse } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type ProviderKey = keys.ProviderKey;
type SetProviderKeyResponse = keys.SetProviderKeyResponse;

function keysPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/provider-keys`;
}

function providerArg(raw: string): string {
  const provider = raw.toLowerCase();
  if (!(keys.PROVIDER_TYPES as readonly string[]).includes(provider)) {
    throw new CliError(
      "usage",
      `Unknown provider "${raw}" (expected ${keys.PROVIDER_TYPES.join("|")})`,
    );
  }
  return provider;
}

async function readKeyInput(opts: { stdin?: boolean }): Promise<string> {
  if (!opts.stdin) {
    const env = process.env.GAUGE_PROVIDER_KEY?.trim();
    if (env) return env;
  }
  if (process.stdin.isTTY) {
    process.stderr.write("Paste the API key, press Enter, then Ctrl-D:\n");
  }
  process.stdin.setEncoding("utf8");
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  const key = data.trim();
  if (!key) {
    throw new CliError(
      "usage",
      "No key provided. Pipe it to stdin (e.g. `gauge keys set anthropic < key.txt`) or set GAUGE_PROVIDER_KEY.",
    );
  }
  return key;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("keys"))
    .description("Manage BYOK provider keys (write-only; reads show last4)");

  group
    .command("set <provider>")
    .description(
      "Set a provider key (anthropic|openai); reads it from stdin or GAUGE_PROVIDER_KEY",
    )
    .option("--stdin", "read the key from stdin (ignores GAUGE_PROVIDER_KEY)")
    .action(
      async (
        provider: string,
        opts: { stdin?: boolean },
        cmd: Command,
      ) => {
        const type = providerArg(provider);
        const org = resolveOrg(cmd);
        const key = await readKeyInput(opts);
        const res = await createClient().put<SetProviderKeyResponse>(
          `${keysPath(org)}/${type}`,
          { key },
        );
        if (resolveOutput(cmd) === "json") printJson(res);
        else console.log(`Saved ${res.providerType} key (…${res.last4})`);
      },
    );

  group
    .command("list")
    .description("List configured provider keys")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const res = await createClient().get<ListResponse<ProviderKey>>(
        keysPath(org),
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else
        printItems(
          res.items.map((k) => ({
            providerType: k.providerType,
            last4: `…${k.last4}`,
            createdAt: k.createdAt,
            updatedAt: k.updatedAt,
          })),
          "table",
        );
    });

  group
    .command("rm <provider>")
    .description("Remove a provider key")
    .action(async (provider: string, _opts: unknown, cmd: Command) => {
      const type = providerArg(provider);
      const org = resolveOrg(cmd);
      await createClient().delete(`${keysPath(org)}/${type}`);
      if (resolveOutput(cmd) !== "json") console.log(`Removed ${type} key`);
    });

  group
    .command("disable-byok")
    .description(
      "Switch back to Gauge-managed metered billing (remove provider keys first)",
    )
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      await createClient().delete(keysPath(org));
      if (resolveOutput(cmd) !== "json")
        console.log("BYOK disabled — runs are Gauge-managed and metered again");
    });
}
