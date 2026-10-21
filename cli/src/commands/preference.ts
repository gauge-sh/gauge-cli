import type { Command } from "commander";
import { resolveOutput } from "../lib/context";
import { filterByCreator } from "../lib/createdBy";
import { collect } from "../lib/flags";
import { printItems, printJson } from "../lib/output";
import {
  addRunSettingsCreateOptions,
  addRunSettingsEditOptions,
} from "../lib/ownedConfig";
import {
  addScenario,
  createPreferencePrompt,
  editPreferencePrompt,
  getPreferencePrompt,
  KIND_CHOICES,
  listPreferencePrompts,
  listScenarios,
  markets,
  type PreferenceCreateOpts,
  type PreferenceEditOpts,
  preferencePromptRow,
  removePreferencePrompt,
  removeScenario,
} from "../lib/preferencePrompts";

export function register(program: Command): void {
  const preference = program
    .command("preference")
    .description(
      "Manage preference prompts: which product agents choose. Launch one with `gauge run --preference <id>`",
    );

  preference
    .command("list")
    .description("List preference prompts")
    .option("--created-by <email|me>", "only prompts created by this user")
    .action(async (opts: { createdBy?: string }, cmd: Command) => {
      const items = await filterByCreator(
        await listPreferencePrompts(cmd),
        opts.createdBy,
      );
      if (resolveOutput(cmd) === "json") printJson(items);
      else printItems(items.map(preferencePromptRow), "table");
    });

  preference
    .command("get <id>")
    .description("Show one preference prompt")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await getPreferencePrompt(cmd, id);
    });

  addRunSettingsCreateOptions(
    preference
      .command("create")
      .description("Create a preference prompt")
      .requiredOption("--name <name>", "name")
      .option("--text <text>", "prompt text inline")
      .option("--file <path>", 'prompt text from a file ("-" for stdin)')
      .option(
        "--repo <url>",
        "the first scenario's repository (default: empty project)",
      )
      .option("--ref <ref>", "branch, tag, or commit (with --repo)")
      .option("--persona <profileId>", "persona profile id"),
  )
    .option("--kind <kind>", KIND_CHOICES.join(" | "))
    .option("--brand-a <name>", "first brand (head-to-head)")
    .option("--brand-b <name>", "second brand (head-to-head)")
    .option("--branded", "an open-ended prompt that names a brand")
    .option(
      "--market <marketId>",
      "tracked market id (see `gauge preference markets`)",
    )
    .option(
      "--tag <name>",
      "user tag name, create-on-type (repeatable)",
      collect,
      [] as string[],
    )
    .action(async (opts: PreferenceCreateOpts, cmd: Command) => {
      await createPreferencePrompt(cmd, opts);
    });

  addRunSettingsEditOptions(
    preference
      .command("edit <id>")
      .description(
        "Update a preference prompt. Omitted flags keep their value.",
      )
      .option("--name <name>", "rename it")
      .option("--text <text>", "replace the prompt text inline")
      .option(
        "--file <path>",
        'replace the prompt text from a file ("-" stdin)',
      ),
  )
    .option("--brand-a <name>", "first brand")
    .option("--brand-b <name>", "second brand")
    .option("--branded", "mark branded (open-ended only)")
    .option("--organic", "mark organic (open-ended only)")
    .option("--market <marketId>", "set the measured market")
    .option("--clear-market", "unscope from any market")
    .option(
      "--tag <name>",
      "replace the user tag set (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-tags", "remove all user tags")
    .action(async (id: string, opts: PreferenceEditOpts, cmd: Command) => {
      await editPreferencePrompt(cmd, id, opts);
    });

  preference
    .command("rm <id>")
    .description("Delete a preference prompt (run history stays)")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await removePreferencePrompt(cmd, id);
    });

  const scenarios = preference
    .command("scenarios")
    .description("The repo × persona scenarios a preference prompt runs in");

  scenarios
    .command("list <id>")
    .description("List a preference prompt's scenarios")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await listScenarios(cmd, id);
    });

  scenarios
    .command("add <id>")
    .description("Add one repo × persona scenario")
    .option("--repo <url>", "repository URL (default: empty project)")
    .option("--ref <ref>", "branch, tag, or commit (with --repo)")
    .option(
      "--persona <profileId>",
      "persona profile id (default persona if omitted)",
    )
    .action(
      async (
        id: string,
        opts: { repo?: string; ref?: string; persona?: string },
        cmd: Command,
      ) => {
        await addScenario(cmd, id, opts);
      },
    );

  scenarios
    .command("rm <id>")
    .description("Remove one scenario")
    .requiredOption("--scenario <scenarioId>", "scenario id to remove")
    .action(async (id: string, opts: { scenario: string }, cmd: Command) => {
      await removeScenario(cmd, id, opts.scenario);
    });

  preference
    .command("markets")
    .description(
      "List tracked and addable markets for preference prompts, or track one with --add",
    )
    .option("--add <marketId>", "track a published market")
    .action(async (opts: { add?: string }, cmd: Command) => {
      await markets(cmd, opts);
    });
}
