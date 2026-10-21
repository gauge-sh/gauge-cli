import type { Command } from "commander";
import { resolveOutput } from "../lib/context";
import {
  createEvalSet,
  type EvalSetCreateOpts,
  type EvalSetEditOpts,
  editEvalSet,
  evalSetRow,
  getEvalSet,
  listEvalSets,
  removeEvalSet,
} from "../lib/evalSets";
import { filterByCreator } from "../lib/createdBy";
import { collect } from "../lib/flags";
import { printItems, printJson } from "../lib/output";
import {
  addRunSettingsCreateOptions,
  addRunSettingsEditOptions,
} from "../lib/ownedConfig";

export function register(program: Command): void {
  const evals = program
    .command("eval")
    .description(
      "Manage eval sets: saved prompts with judged criteria. Launch one with `gauge run --eval <id>`",
    );

  evals
    .command("list")
    .description("List eval sets")
    .option("--agents <agents>", "stats for these agents only (csv)")
    .option("--models <models>", "stats for these model slugs only (csv)")
    .option("--since <date>", "stats for runs since this ISO date only")
    .option("--created-by <email|me>", "only evals created by this user")
    .action(
      async (
        opts: {
          agents?: string;
          models?: string;
          since?: string;
          createdBy?: string;
        },
        cmd: Command,
      ) => {
        const items = await filterByCreator(
          await listEvalSets(cmd, opts),
          opts.createdBy,
        );
        if (resolveOutput(cmd) === "json") printJson(items);
        else printItems(items.map(evalSetRow), "table");
      },
    );

  evals
    .command("get <id>")
    .description("Show one eval set")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await getEvalSet(cmd, id);
    });

  addRunSettingsCreateOptions(
    evals
      .command("create")
      .description("Create an eval set")
      .requiredOption("--name <name>", "name")
      .option("--text <text>", "prompt text inline")
      .option("--file <path>", 'prompt text from a file ("-" for stdin)')
      .option(
        "--repo <url>",
        "consumer repository (default: empty locally, Gauge scaffold hosted)",
      )
      .option("--ref <ref>", "branch, tag, or commit (with --repo)")
      .option("--persona <profileId>", "persona profile id"),
  )
    .option(
      "--criterion <spec>",
      'judged criterion as "Name: rubric text" (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      "--criteria-file <path>",
      'JSON array of {name, rubric} ("-" for stdin)',
    )
    .option(
      "--tag <name>",
      "user tag name, create-on-type (repeatable)",
      collect,
      [] as string[],
    )
    .action(async (opts: EvalSetCreateOpts, cmd: Command) => {
      await createEvalSet(cmd, opts);
    });

  addRunSettingsEditOptions(
    evals
      .command("edit <id>")
      .description(
        "Update an eval set. Omitted flags keep their value. A criteria list REPLACES the whole set (use --criteria-file with ids to edit in place).",
      )
      .option("--name <name>", "rename it")
      .option("--text <text>", "replace the prompt text inline")
      .option(
        "--file <path>",
        'replace the prompt text from a file ("-" stdin)',
      )
      .option("--repo <url>", "set the repository (keeps a ref pin)")
      .option("--ref <ref>", "set the branch, tag, or commit pin")
      .option("--clear-ref", "drop the ref pin")
      .option(
        "--clear-repo",
        "use an empty workspace locally or the default scaffold hosted",
      )
      .option("--persona <profileId>", "set the persona profile id")
      .option("--clear-persona", "use the default persona"),
  )
    .option(
      "--criterion <spec>",
      'criterion as "Name: rubric", replaces the whole set (repeatable)',
      collect,
      [] as string[],
    )
    .option(
      "--criteria-file <path>",
      "JSON array of {id?, name, rubric}; entries with id update in place",
    )
    .option(
      "--tag <name>",
      "replace the user tag set (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-tags", "remove all user tags")
    .action(async (id: string, opts: EvalSetEditOpts, cmd: Command) => {
      await editEvalSet(cmd, id, opts);
    });

  evals
    .command("rm <id>")
    .description("Delete an eval set (run history stays)")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      await removeEvalSet(cmd, id);
    });
}
