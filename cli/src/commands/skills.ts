import type { skills } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

function skillsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/skills`;
}

function skillPath(org: string, ref: string): string {
  return `${skillsPath(org)}/${encodeURIComponent(ref)}`;
}

function sourceLabel(s: skills.SkillSourceWire | null): string {
  if (!s) return "";
  const path = s.subpath ? `/${s.subpath}` : "";
  return `${s.repoFullName}${path}#${s.ref}${s.autoIngest ? " (auto)" : ""}`;
}

export type SkillEditOpts = {
  rename?: string;
  note?: string;
  clearNote?: boolean;
  source?: string;
  clearSource?: boolean;
  autoIngest?: string;
};

export async function buildSkillEditBody(
  opts: SkillEditOpts,
  fetchCurrentSource: () => Promise<skills.SkillSourceWire | null>,
): Promise<Record<string, unknown>> {
  if (opts.note !== undefined && opts.clearNote)
    throw new CliError("usage", "--note and --clear-note conflict");
  if (opts.source !== undefined && opts.clearSource)
    throw new CliError("usage", "--source and --clear-source conflict");
  if (opts.autoIngest !== undefined && opts.clearSource)
    throw new CliError("usage", "--auto-ingest and --clear-source conflict");
  let autoIngest: boolean | undefined;
  if (opts.autoIngest !== undefined) {
    if (opts.autoIngest !== "true" && opts.autoIngest !== "false")
      throw new CliError("usage", "--auto-ingest expects true or false");
    autoIngest = opts.autoIngest === "true";
  }

  const body: Record<string, unknown> = {};
  if (opts.rename !== undefined) body.name = opts.rename;
  if (opts.clearNote) body.note = null;
  else if (opts.note !== undefined) body.note = opts.note;
  if (opts.clearSource) body.source = null;
  else if (opts.source !== undefined) {
    const m = opts.source.match(/^([^#]+\/[^#/]+)#([^/]+)(?:\/(.+))?$/);
    if (!m)
      throw new CliError(
        "usage",
        'invalid --source (expected "owner/repo#branch" or "owner/repo#branch/subpath")',
      );
    body.source = {
      repoFullName: m[1],
      ref: m[2],
      subpath: m[3],
      autoIngest,
    };
  } else if (autoIngest !== undefined) {
    const current = await fetchCurrentSource();
    if (!current)
      throw new CliError(
        "usage",
        "this skill has no tracked source — set one first with --source owner/repo#branch",
      );
    body.source = {
      repoFullName: current.repoFullName,
      ref: current.ref,
      subpath: current.subpath || undefined,
      autoIngest,
    };
  }
  if (Object.keys(body).length === 0)
    throw new CliError("usage", "nothing to change");
  return body;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("skills"))
    .description("Manage agent skills used by eval and preference runs");

  group
    .command("list")
    .description("List the org's skills with their newest version")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const res = await createClient().get<skills.ListSkillsResponse>(
        skillsPath(org),
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else
        printItems(
          res.items.map((s) => ({
            name: s.name,
            latest: s.latestVersion?.label ?? "",
            versions: s.versionCount,
            source: sourceLabel(s.source),
            note: s.note ?? "",
          })),
          "table",
        );
    });

  group
    .command("get <ref>")
    .description("Show one skill: source, note, every version")
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const skill = await createClient().get<skills.SkillDetail>(
        skillPath(org, ref),
      );
      if (resolveOutput(cmd) === "json") {
        printJson(skill);
        return;
      }
      console.log(`name:    ${skill.name}`);
      console.log(`id:      ${skill.id}`);
      console.log(`note:    ${skill.note ?? "(none)"}`);
      console.log(`source:  ${sourceLabel(skill.source) || "(untracked)"}`);
      console.log("versions:");
      for (const v of skill.versions)
        console.log(
          `  ${skill.name}@${v.label}  ${v.contentDigest.slice(0, 19)}  ${v.createdAt}`,
        );
    });

  group
    .command("add <reference>")
    .description("Ingest a skill from owner/repo[/skill][#ref] or a GitHub URL")
    .option("--as <handle>", "the handle (default: the directory basename)")
    .option(
      "--label <label>",
      "version label (a typed label always mints; omitted dedups by digest)",
    )
    .option("--skill <name>", "select one skill from a source holding several")
    .option("--note <text>", "note shown on the index")
    .option(
      "--track",
      "track the source branch for auto re-ingest (reference must name a branch)",
    )
    .action(
      async (
        reference: string,
        opts: {
          as?: string;
          label?: string;
          skill?: string;
          note?: string;
          track?: boolean;
        },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        const result = await createClient().post<skills.AddSkillResponse>(
          skillsPath(org),
          {
            reference,
            handle: opts.as,
            label: opts.label,
            skill: opts.skill,
            note: opts.note,
            trackSource: opts.track,
          },
        );
        if (resolveOutput(cmd) === "json") {
          printJson(result);
          return;
        }
        console.log(
          result.unchanged
            ? `Already current: ${result.handle}@${result.label} carries this content`
            : `Ingested ${result.handle}@${result.label}`,
        );
        console.error(
          `Attach it to an eval: gauge eval edit <id> --skill ${result.handle}@${result.label}`,
        );
      },
    );

  group
    .command("edit <ref>")
    .description("Rename, note, or repoint a skill's tracked source")
    .option("--rename <handle>", "new handle (name@label refs must be updated)")
    .option("--note <text>", "replace the note")
    .option("--clear-note", "remove the note")
    .option(
      "--source <owner/repo#branch[/subpath]>",
      "set the tracked source branch",
    )
    .option("--clear-source", "stop tracking the source")
    .option(
      "--auto-ingest <bool>",
      "true|false — auto re-ingest on new commits",
    )
    .action(async (ref: string, opts: SkillEditOpts, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const client = createClient();
      const body = await buildSkillEditBody(opts, async () => {
        const skill = await client.get<skills.SkillDetail>(skillPath(org, ref));
        return skill.source;
      });
      const updated = await client.patch<skills.SkillDetail>(
        skillPath(org, ref),
        body,
      );
      if (resolveOutput(cmd) === "json") printJson(updated);
      else console.log(`Updated skill ${updated.name}`);
    });

  group
    .command("reingest <ref>")
    .description("Pull the tracked source now (no-op when already current)")
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const result = await createClient().post<skills.ReingestSkillResponse>(
        `${skillPath(org, ref)}/reingest`,
        {},
      );
      if (resolveOutput(cmd) === "json") printJson(result);
      else
        console.log(
          result.unchanged
            ? "Already current — nothing new upstream"
            : `Ingested new version ${ref}@${result.label}`,
        );
    });

  group
    .command("rm <ref>")
    .description(
      "Remove a skill; the handle stays reserved and finished runs keep their snapshot",
    )
    .action(async (ref: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const result = await createClient().delete<{
        referencedBatches: number;
        referencedRuns: number;
      }>(skillPath(org, ref));
      if (resolveOutput(cmd) === "json") printJson(result);
      else
        console.log(
          `Deleted skill ${ref} (${result.referencedRuns} finished run(s) referenced it)`,
        );
    });

  group
    .command("runs <ref>")
    .description("Recent sessions that staged this skill")
    .option("--limit <n>", "max runs (default 10, cap 50)")
    .action(async (ref: string, opts: { limit?: string }, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const res = await createClient().get<skills.ListSkillRunsResponse>(
        `${skillPath(org, ref)}/runs`,
        { limit: opts.limit },
      );
      if (resolveOutput(cmd) === "json") {
        printJson(res.items);
        return;
      }
      printItems(
        res.items.map((r) => ({
          id: r.runId,
          agent: r.agent,
          version: r.versionLabel ?? "",
          turns: r.turns ?? "",
          cost: r.costUsd == null ? "" : `$${r.costUsd.toFixed(2)}`,
          finished: r.finishedAt ?? "(running)",
        })),
        "table",
      );
    });
}
