import type { Command } from "commander";
import { ensureAccount } from "../lib/account";
import { hostedOnly, resolveOutput } from "../lib/context";
import { gaugeState } from "../lib/gaugeState";
import { printJson } from "../lib/output";

export function register(program: Command): void {
  hostedOnly(program.command("onboard"), { account: true })
    .description(
      "Sign in to hosted Gauge and set up your workspace. Then run `gauge init --hosted` in a repo to connect it",
    )
    .option("--email <email>", "email a sign-in link (device-flow convenience)")
    .option("--org-name <name>", "workspace name (default: from your email)")
    .option(
      "--website <url>",
      "company site, scanned to seed the workspace (default: from your email)",
    )
    .option("--new", "create a new workspace even if you already belong to one")
    .option(
      "--no-seed",
      "skip seeding starter eval sets and the Agent Preference portfolio",
    )
    .action(
      async (
        opts: {
          email?: string;
          orgName?: string;
          website?: string;
          new?: boolean;
          seed?: boolean;
        },
        command: Command,
      ) => {
        const output = resolveOutput(command);
        const account = await ensureAccount({
          ...opts,
          log: output === "json" ? () => {} : console.log,
        });
        if (output === "json") {
          printJson({
            user: account.user,
            org: account.organization,
            orgId: account.org,
            seeded: account.seeded,
          });
          return;
        }
        console.log(`\nDefault org set to ${account.organization.slug}. You're ready:`);
        console.log("  gauge status                    # the org at a glance");
        console.log(
          "  gauge eval list                 # eval sets",
          "  gauge preference list           # preference prompts",
        );
        console.log("  gauge run --eval <id>           # launch one now");
        let inRepo = false;
        try {
          inRepo = gaugeState(command).inRepo;
        } catch {}
        console.log(
          inRepo
            ? "  gauge init --hosted             # connect this repo"
            : "  gauge init --hosted             # connect a repo (run it inside the repo)",
        );
      },
    );
}
