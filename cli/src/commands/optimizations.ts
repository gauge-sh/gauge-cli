import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { optimizations } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { confirmOrAbort } from "../lib/confirm";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { parseAgentSpec } from "../lib/flags";
import { printItems, printJson } from "../lib/output";

type Summary = optimizations.OptimizationSummary;
type Detail = optimizations.OptimizationDetail;
type Trial = optimizations.Trial;
type TrialContent = optimizations.TrialContent;
type Diagnosis = optimizations.Diagnosis;

const TERMINAL = new Set<string>(["DONE", "ARCHIVED"]);

function basePath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/optimizations`;
}

function itemPath(org: string, id: string): string {
  return `${basePath(org)}/${encodeURIComponent(id)}`;
}

function trialPath(org: string, id: string, trialId: string): string {
  return `${itemPath(org, id)}/trials/${encodeURIComponent(trialId)}`;
}

const FAILED_RUN = new Set(["FAILED", "TIMED_OUT"]);

function readText(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type SubjectOpts = { eval?: string; preference?: string };

export function parseSubject(opts: SubjectOpts): {
  subjectKind: "EVAL_SET" | "VISIBILITY_PROMPT";
  subjectId: string;
} {
  if (opts.eval && opts.preference)
    throw new CliError("usage", "pass --eval or --preference, not both");
  if (opts.eval) return { subjectKind: "EVAL_SET", subjectId: opts.eval };
  if (opts.preference)
    return { subjectKind: "VISIBILITY_PROMPT", subjectId: opts.preference };
  throw new CliError("usage", "pass --eval <id> or --preference <id>");
}

export function parseTarget(raw: string): { agent: string; model?: string } {
  const spec = parseAgentSpec(raw);
  if (spec.models.length > 1)
    throw new CliError(
      "usage",
      `--target "${raw}" names several models; an optimization pins exactly one`,
    );
  return spec.models.length
    ? { agent: spec.agent, model: spec.models[0] }
    : { agent: spec.agent };
}

function parseCount(
  raw: string | undefined,
  flag: string,
  max = 100,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max)
    throw new CliError(
      "usage",
      `${flag} must be a positive integer no greater than ${max}`,
    );
  return n;
}

export const NEEDS_INPUT_EXIT = 4;

const NEXT_ACTION_HINT: Record<string, string> = {
  START: "start the draft: `gauge optimizations start-draft <id>`",
  WAIT: "sessions are running; nothing to do",
  AUTHOR_TRIAL: "author the next trial: `gauge optimizations trials add <id>`",
  LAUNCH_ROUND: "launch the saved round: `gauge optimizations launch <id>`",
  ADOPT: "adopt the winning trial: `gauge optimizations adopt <id> <trial>`",
  RESUME: "resume it in the web app, or `gauge optimizations cancel <id>`",
  NONE: "nothing to do in Gauge",
};

export function awaitingInput(detail: Pick<Detail, "nextAction">) {
  return detail.nextAction !== "WAIT" && detail.nextAction !== "NONE";
}

export function watchStops(
  detail: Pick<Detail, "status" | "nextAction">,
  follow: boolean,
) {
  return (
    TERMINAL.has(detail.status) ||
    detail.nextAction === "NONE" ||
    (!follow && awaitingInput(detail))
  );
}

function readObject(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(readText(path));
  } catch {
    throw new CliError("usage", "the file must contain valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CliError("usage", "the file must contain a JSON object");
  return value as Record<string, unknown>;
}

type TargetOpts = { target?: string };

function targetFromOpts(opts: TargetOpts) {
  return opts.target ? { target: parseTarget(opts.target) } : {};
}

export function parseStatuses(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
  for (const part of parts)
    if (!["DRAFT", "ACTIVE", "PAUSED", "DONE", "ARCHIVED"].includes(part))
      throw new CliError(
        "usage",
        `unknown status "${part}" (expected DRAFT, ACTIVE, PAUSED, DONE, ARCHIVED)`,
      );
  return parts.join(",");
}

type TrialOpts = {
  file?: string;
  pick?: string;
  title?: string;
  hypothesis?: string;
  lever?: string;
  editSkill?: string;
  skillDir?: string;
  page?: string;
  bodyFile?: string;
  launch?: boolean;
  idempotencyKey?: string;
};

export function readSkillDir(
  dir: string,
  read: (path: string) => string = readText,
  walk: (path: string) => string[] = listFiles,
): { path: string; body: string }[] {
  const paths = walk(dir).sort();
  if (!paths.length)
    throw new CliError("usage", `no files under ${dir} to send`);
  const files = paths.map((path) => ({
    path: relative(dir, path).split(sep).join("/"),
    body: read(path),
  }));
  if (!files.some((file) => file.path === "SKILL.md"))
    throw new CliError(
      "usage",
      `${dir} has no SKILL.md; a skill bundle must carry one`,
    );
  return files;
}

function listFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).map(String);
  } catch {
    throw new CliError("usage", `cannot read the directory ${dir}`);
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

export function trialBodyFromOpts(
  opts: TrialOpts,
  read: (path: string) => string = readText,
  walk?: (path: string) => string[],
): optimizations.CreateTrialBodyInput {
  const launch = opts.launch === true;
  const idempotencyKey = opts.idempotencyKey;
  if (opts.file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(read(opts.file));
    } catch {
      throw new CliError("usage", "the trial file must contain valid JSON");
    }
    const pick = parseCount(opts.pick, "--pick") ?? 1;
    let chosen: unknown;
    if (Array.isArray(parsed)) {
      if (pick > parsed.length)
        throw new CliError(
          "usage",
          `--pick ${pick} but the file holds ${parsed.length} proposal${parsed.length === 1 ? "" : "s"}`,
        );
      chosen = parsed[pick - 1];
    } else {
      if (opts.pick !== undefined)
        throw new CliError("usage", "--pick applies to a proposals array");
      chosen = parsed;
    }
    if (!chosen || typeof chosen !== "object" || Array.isArray(chosen))
      throw new CliError(
        "usage",
        "the trial file must contain an object or a non-empty array of objects",
      );
    const record = chosen as Record<string, unknown>;
    const body = (
      "trial" in record ? record : { trial: record }
    ) as optimizations.CreateTrialBodyInput;
    return {
      ...body,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      launch,
    };
  }
  if (!opts.title) throw new CliError("usage", "--title is required");
  const lever = opts.lever?.toUpperCase();
  let intervention: Record<string, unknown>;
  let files: { path: string; body: string }[] | undefined;
  if (opts.page || opts.bodyFile) {
    if (!opts.page || !opts.bodyFile)
      throw new CliError("usage", "--page and --body-file go together");
    intervention = {
      kind: "REWRITE_DOCS",
      after: { pages: [{ url: opts.page, body: read(opts.bodyFile) }] },
    };
  } else if (opts.editSkill) {
    if (!opts.skillDir)
      throw new CliError(
        "usage",
        "--edit-skill needs --skill-dir <path>: an edit sends the complete bundle",
      );
    intervention = {
      kind: "EDIT_SKILL",
      before: { skillVersionId: opts.editSkill },
      after: { skillVersionId: opts.editSkill },
    };
    files = readSkillDir(opts.skillDir, read, walk);
  } else {
    throw new CliError(
      "usage",
      "describe the change: --edit-skill <id> --skill-dir <path>, --page <url> --body-file <path>, or --file <trial.json>",
    );
  }
  const trial = {
    title: opts.title,
    hypothesis: opts.hypothesis,
    lever: lever ?? (intervention.kind === "REWRITE_DOCS" ? "DOCS" : "SKILL"),
    intervention,
    authorMode: "MANUAL" as const,
  } as unknown as optimizations.CreateTrialBodyInput["trial"];
  return {
    trial,
    ...(files ? { files } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    launch,
  };
}

const TRIAL_TEMPLATES: Record<string, optimizations.CreateTrialBodyInput> = {
  EDIT_SKILL: {
    trial: {
      title: "Name the env var in the first line",
      hypothesis: "The agent reads only the opening paragraph",
      lever: "SKILL",
      intervention: {
        kind: "EDIT_SKILL",
        before: { skillVersionId: "sv_REPLACE_ME" },
        after: { skillVersionId: "sv_REPLACE_ME" },
      },
      authorMode: "MANUAL",
    },
    files: [
      { path: "SKILL.md", body: "# Skill\n\nThe complete rewritten file.\n" },
    ],
  },
  REWRITE_DOCS: {
    trial: {
      title: "Move the auth note above the example",
      hypothesis: "The agent copies the example before reading the note",
      lever: "DOCS",
      intervention: {
        kind: "REWRITE_DOCS",
        after: {
          pages: [
            {
              url: "https://example.com/docs/quickstart",
              body: "The complete rewritten page body.",
            },
          ],
        },
      },
      authorMode: "MANUAL",
    },
  },
} as unknown as Record<string, optimizations.CreateTrialBodyInput>;

export function trialTemplate(
  kind: string,
): optimizations.CreateTrialBodyInput {
  const template = TRIAL_TEMPLATES[kind.trim().toUpperCase()];
  if (!template)
    throw new CliError(
      "usage",
      `--kind must be one of ${Object.keys(TRIAL_TEMPLATES).join(", ")} (got "${kind}")`,
    );
  return template;
}

function pct(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "—"
    : `${Math.round(value * 100)}%`;
}

function subjectLabel(kind: string): string {
  return kind === "EVAL_SET" ? "eval" : "preference";
}

function toRow(o: Summary) {
  return {
    id: o.id,
    name: o.name.length > 40 ? `${o.name.slice(0, 37)}...` : o.name,
    status: o.status,
    subject: `${subjectLabel(o.subjectKind)} ${o.subjectName}`,
    round: o.round,
    baseline: pct(o.before),
    now: pct(o.after),
    delta: o.delta === null ? "—" : `${o.delta > 0 ? "+" : ""}${o.delta}pt`,
    credits: o.creditsSpent,
    updated: o.updatedAt,
  };
}

function trialRow(t: Trial) {
  return {
    key: t.key,
    round: t.roundNumber,
    title: t.title.length > 48 ? `${t.title.slice(0, 45)}...` : t.title,
    surface: t.lever ?? "",
    change: t.kind,
    status: t.status,
    score: pct(t.score),
    result: t.verdict ?? "",
    sessions: t.sessions,
    failed: t.failedSessions || "",
    winner: t.adopted ? "yes" : "",
    id: t.id,
  };
}

function printDetail(o: Detail): void {
  console.log(`id:        ${o.id}`);
  console.log(`name:      ${o.name}`);
  console.log(
    `status:    ${o.status}${o.stopReason ? ` (${o.stopReason})` : ""}`,
  );
  console.log(
    `mode:      ${o.autonomous ? "autonomous (legacy)" : "interactive; launch each saved round explicitly"}`,
  );
  console.log(
    `subject:   ${subjectLabel(o.subjectKind)} ${o.subjectName} (${o.subjectId})`,
  );
  console.log(
    `target:    ${o.settings.pinnedAgent ?? "(subject roster)"}${o.settings.pinnedModel ? `:${o.settings.pinnedModel}` : ""}`,
  );
  console.log(`sessions:  ${o.settings.sampleCount} per trial`);
  console.log(`credits:   ${o.creditsSpent} spent`);
  console.log(
    `score:     ${pct(o.before)} → ${pct(o.after)}${o.delta === null ? "" : ` (${o.delta > 0 ? "+" : ""}${o.delta}pt)`}`,
  );
  if (o.summary) console.log(`summary:   ${o.summary}`);
  console.log(
    `next:      ${o.nextAction} — ${NEXT_ACTION_HINT[o.nextAction] ?? ""}`,
  );
  console.log("trials:");
  const trials = o.rounds.flatMap((round) => round.trials);
  printItems(trials.map(trialRow), "table");
  for (const round of o.rounds)
    if (round.narrative)
      console.log(`round ${round.number}: ${round.narrative}`);
  for (const line of trials.flatMap(trialWarnings)) console.error(line);
}

function runDetails(id: string) {
  return `(details: \`gauge run get ${id}\`, \`gauge run get ${id} --logs\`)`;
}

export function trialWarnings(t: Trial): string[] {
  const total = `${t.runs.length} session${t.runs.length === 1 ? "" : "s"}`;
  const failed = t.runs.filter((run) => FAILED_RUN.has(run.status));
  const unproven = t.runs.filter(
    (run) =>
      !FAILED_RUN.has(run.status) && run.cliCoverage?.instrumentationFailed,
  );
  const lines: string[] = [];
  if (failed.length)
    lines.push(
      `WARNING ${t.key}: ${failed.length} of ${total} failed; the score and verdict leave them out. Tell the user before you trust this result.`,
      ...failed.map(
        (run) =>
          `  ${run.id}: ${run.status}: ${run.failureReason ?? run.exitReason ?? "no reason recorded"} ${runDetails(run.id)}`,
      ),
    );
  if (unproven.length)
    lines.push(
      `WARNING ${t.key}: ${unproven.length} of ${total} have incomplete command evidence; the score counts them, but the CLI change may not have applied. Tell the user.`,
      ...unproven.map((run) => `  ${run.id}: ${runDetails(run.id)}`),
    );
  return lines;
}

function printTrial(t: Trial): void {
  console.log(`key:        ${t.key} (round ${t.roundNumber}) — ${t.id}`);
  console.log(`title:      ${t.title}`);
  if (t.hypothesis) console.log(`hypothesis: ${t.hypothesis}`);
  console.log(`change:     ${t.kind}${t.lever ? ` on ${t.lever}` : ""}`);
  console.log(
    `status:     ${t.status}${t.verdict ? ` · ${t.verdict}` : ""}${t.adopted ? " · winner" : ""}`,
  );
  console.log(
    `score:      ${pct(t.baselineScore)} → ${pct(t.score)} over ${t.sessions} session${t.sessions === 1 ? "" : "s"}`,
  );
  if (t.outcome) console.log(`outcome:    ${t.outcome}`);
  if (t.runs.length) {
    console.log("sessions:");
    for (const run of t.runs) {
      const verdict =
        run.passed === null ? "not assessed" : run.passed ? "pass" : "fail";
      console.log(`  ${run.id}: ${run.status} · ${verdict}`);
      if (FAILED_RUN.has(run.status))
        console.log(
          `      error: ${run.failureReason ?? run.exitReason ?? "no reason recorded"}`,
        );
      else if (run.cliCoverage?.instrumentationFailed)
        console.log("      warning: command evidence is incomplete");
      for (const criterion of run.criteria)
        console.log(
          `      ${criterion.passed === null ? "?" : criterion.passed ? "✓" : "✗"} ${criterion.name}`,
        );
    }
  }
  for (const line of trialWarnings(t)) console.error(line);
}

function printChange(content: TrialContent): void {
  for (const doc of content.documents) {
    console.log(`=== ${doc.path}`);
    console.log("--- before");
    console.log(doc.before || "(empty)");
    console.log("+++ after");
    console.log(doc.after || "(empty)");
  }
}

type RoundPreview = {
  revision: string;
  previewDigest: string;
  trials: {
    title: string;
    changes?: { path: string; hunks: string }[];
    droppedFiles?: string[];
  }[];
};
type RoundSaved = { trials: { id: string; key: string; title: string }[] };

function printRoundPreview(preview: RoundPreview): void {
  for (const trial of preview.trials) {
    console.log(trial.title);
    for (const change of trial.changes ?? []) {
      console.log(`=== ${change.path}`);
      console.log(change.hunks);
    }
    for (const path of trial.droppedFiles ?? [])
      console.log(`  ${path}: dropped`);
  }
  console.log(`previewDigest ${preview.previewDigest}`);
}

function printDiagnosis(d: Diagnosis): void {
  console.log(`id:          ${d.id}`);
  console.log(`status:      ${d.status} over ${d.runCount} sessions`);
  console.log(`summary:     ${d.summary ?? "(none)"}`);
  console.log(`recommended: ${d.recommendedLever ?? "no single lever"}`);
  if (d.unsupportedLevers.length)
    console.log(`not yet supported: ${d.unsupportedLevers.join(", ")}`);
  if (d.clusters.length) {
    console.log("opportunities:");
    for (const cluster of d.clusters)
      console.log(
        `  - ${cluster.title} [${cluster.lever ?? "?"} · ${Math.round(cluster.confidence * 100)}%] ${cluster.failureMode}`,
      );
  }
}

function addSubjectOptions(command: Command): Command {
  return command
    .option("--eval <id>", "an Agent Experience eval")
    .option("--preference <id>", "an Agent Preference prompt");
}

function addTargetOption(command: Command): Command {
  return command.option(
    "--target <agent[:model]>",
    "the one harness/model every session runs on, e.g. claude-code:claude-opus-4-8",
  );
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("optimizations"))
    .description(
      "Start, steer, and read optimizations: Gauge changes one owned surface per trial and reports the best measured change against the baseline",
    );

  group
    .command("list")
    .description("List the org's optimizations, newest activity first")
    .option(
      "--status <statuses>",
      "comma-separated: DRAFT,ACTIVE,PAUSED,DONE,ARCHIVED",
    )
    .option("--no-drafts", "leave out draft workspaces")
    .option("--eval <id>", "only optimizations on this eval")
    .option("--preference <id>", "only optimizations on this preference prompt")
    .option("--limit <n>", "max rows (default 50)")
    .action(
      async (
        opts: SubjectOpts & {
          status?: string;
          limit?: string;
          drafts: boolean;
        },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const subject =
          opts.eval || opts.preference ? parseSubject(opts) : undefined;
        const res =
          await createClient().get<optimizations.ListOptimizationsResponse>(
            basePath(org),
            {
              status: parseStatuses(opts.status),
              subjectKind: subject?.subjectKind,
              subjectId: subject?.subjectId,
              limit: parseCount(opts.limit, "--limit", 200),
              includeDrafts: opts.drafts,
            },
          );
        if (resolveOutput(cmd) === "json") printJson(res.items);
        else printItems(res.items.map(toRow), "table");
      },
    );

  addSubjectOptions(
    group
      .command("baselines")
      .description(
        "Discover which ordinary runs exposed which owned surfaces, and whether they can seed an optimization",
      ),
  )
    .option("--limit <n>", "page size (1–100)", "50")
    .option("--cursor <cursor>", "nextCursor from the previous page")
    .action(
      async (
        opts: SubjectOpts & { limit?: string; cursor?: string },
        cmd: Command,
      ) => {
        const response =
          await createClient().get<optimizations.BaselineDiscoveryResponse>(
            `${basePath(resolveOrg(cmd))}/baselines`,
            {
              ...parseSubject(opts),
              limit: parseCount(opts.limit, "--limit"),
              cursor: opts.cursor,
            },
          );
        if (resolveOutput(cmd) === "json") printJson(response);
        else {
          printItems(
            response.items.flatMap((run) =>
              (run.surfaces.length
                ? run.surfaces
                : [{ lever: "—", label: "No recorded surface evidence" }]
              ).map((surface) => ({
                run: run.runId,
                model: run.model || run.resolvedModel || run.agent,
                date: run.createdAt.slice(0, 10),
                criteria: run.outcome.totalCriteria
                  ? `${run.outcome.passedCriteria}/${run.outcome.totalCriteria}`
                  : "—",
                status: run.status,
                surface: surface.lever,
                target: surface.label,
                eligible: run.eligibility.eligible ? "yes" : "no",
              })),
            ),
            "table",
          );
          for (const run of response.items)
            if (run.eligibility.reason)
              console.log(`${run.runId}: ${run.eligibility.reason}`);
          console.log(response.note);
          if (response.nextCursor)
            console.log(`More: --cursor ${response.nextCursor}`);
        }
      },
    );

  group
    .command("get <id>")
    .description("One optimization: settings, score, and its trial ladder")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const detail = await createClient().get<Detail>(itemPath(org, id));
      if (resolveOutput(cmd) === "json") printJson(detail);
      else printDetail(detail);
    });

  addSubjectOptions(
    group
      .command("diagnose")
      .description(
        "Improvement opportunities for an eval or preference prompt from its judged sessions",
      ),
  ).action(async (opts: SubjectOpts, cmd: Command) => {
    const org = resolveOrg(cmd);
    const diagnosis = await createClient().post<Diagnosis>(
      `${basePath(org)}/diagnoses`,
      parseSubject(opts),
    );
    if (resolveOutput(cmd) === "json") printJson(diagnosis);
    else printDiagnosis(diagnosis);
  });

  addTargetOption(
    addSubjectOptions(
      group
        .command("start")
        .description(
          "Reuse a selected baseline with --from-run, or establish one with --target",
        ),
    ),
  )
    .option(
      "--from-run <runId>",
      "reuse the eligible baseline containing this run; inherits its model",
    )
    .option("--name <name>", "optimization name (default: from the subject)")
    .option("--yes", "skip the confirmation")
    .action(
      async (
        opts: SubjectOpts &
          TargetOpts & { name?: string; yes?: boolean; fromRun?: string },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        if (!!opts.target === !!opts.fromRun)
          throw new CliError(
            "usage",
            "pass --from-run <runId> or --target <agent[:model]>, not both; discover runs with `gauge optimizations baselines`",
          );
        const subject = parseSubject(opts);
        await confirmOrAbort(
          opts.fromRun
            ? `Start an optimization from the baseline containing ${opts.fromRun}?`
            : `Start an optimization on ${subjectLabel(subject.subjectKind)} ${subject.subjectId}? A new baseline may spend credits.`,
          opts.yes,
        );
        const detail = await createClient().post<Detail>(basePath(org), {
          ...subject,
          ...targetFromOpts(opts),
          ...(opts.fromRun ? { fromRun: opts.fromRun } : {}),
          name: opts.name,
        });
        if (resolveOutput(cmd) === "json") printJson(detail);
        else {
          console.log(
            `Started ${detail.id} "${detail.name}". Each round waits for you to launch it. Follow the baseline with \`gauge optimizations watch ${detail.id}\`.`,
          );
        }
      },
    );

  group
    .command("cancel <id>")
    .description("Cancel an optimization and stop its in-flight sessions")
    .option("--yes", "skip the confirmation")
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const org = resolveOrg(cmd);
      await confirmOrAbort(
        `Cancel optimization ${id}? In-flight sessions stop; completed usage remains billed.`,
        opts.yes,
      );
      const detail = await createClient().post<Detail>(
        `${itemPath(org, id)}/cancel`,
        {},
      );
      if (resolveOutput(cmd) === "json") printJson(detail);
      else
        console.log(
          `${detail.id}: ${detail.status}${detail.stopReason ? ` (${detail.stopReason})` : ""}`,
        );
    });

  addTargetOption(
    addSubjectOptions(
      group
        .command("create")
        .description("Create a draft workspace without running sessions"),
    ),
  )
    .option("--name <name>", "optimization name")
    .action(
      async (
        opts: SubjectOpts & TargetOpts & { name?: string },
        cmd: Command,
      ) => {
        const detail = await createClient().post<Detail>(
          `${basePath(resolveOrg(cmd))}/drafts`,
          {
            ...parseSubject(opts),
            ...targetFromOpts(opts),
            name: opts.name,
          },
        );
        if (resolveOutput(cmd) === "json") printJson(detail);
        else printDetail(detail);
      },
    );

  addTargetOption(
    group
      .command("edit <id>")
      .description("Edit name/direction, or a draft's target"),
  )
    .option("--name <name>", "optimization name")
    .option(
      "--file <path>",
      "PATCH body JSON (name, direction, target); '-' for stdin",
    )
    .action(
      async (
        id: string,
        opts: TargetOpts & { name?: string; file?: string },
        cmd: Command,
      ) => {
        const body = {
          ...(opts.file ? readObject(opts.file) : {}),
          ...targetFromOpts(opts),
          ...(opts.name ? { name: opts.name } : {}),
        };
        if (!Object.keys(body).length)
          throw new CliError("usage", "pass --target, --name, or --file");
        const detail = await createClient().patch<Detail>(
          itemPath(resolveOrg(cmd), id),
          body,
        );
        if (resolveOutput(cmd) === "json") printJson(detail);
        else printDetail(detail);
      },
    );

  addTargetOption(
    group
      .command("start-draft <id>")
      .description("Start an existing draft's baseline (spends credits)"),
  )
    .option("--name <name>", "optimization name")
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        opts: TargetOpts & { name?: string; yes?: boolean },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const client = createClient();
        const plan = targetFromOpts(opts);
        const current = await client.get<Detail>(itemPath(org, id));
        if (current.status !== "DRAFT")
          throw new CliError(
            "usage",
            "only a draft can start; use continue instead",
          );
        if (!plan.target && !current.settings.pinnedAgent)
          throw new CliError(
            "usage",
            "--target is required until the draft has an agent/model",
          );
        await confirmOrAbort(
          `Start the baseline for ${id}? It spends credits now.`,
          opts.yes,
        );
        const detail = await client.post<Detail>(`${itemPath(org, id)}/start`, {
          ...plan,
          name: opts.name,
        });
        if (resolveOutput(cmd) === "json") printJson(detail);
        else printDetail(detail);
      },
    );

  group
    .command("launch <id>")
    .description(
      "Launch all saved trials in the current round (spends credits)",
    )
    .option("--yes", "skip the confirmation")
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      await confirmOrAbort(
        `Launch the current round of ${id}? Spends credits.`,
        opts.yes,
      );
      const result =
        await createClient().post<optimizations.LaunchRoundResponse>(
          `${itemPath(resolveOrg(cmd), id)}/rounds/current/launch`,
          {},
        );
      if (resolveOutput(cmd) === "json") printJson(result);
      else
        console.log(
          result.alreadyLaunched
            ? "Round already launched."
            : `Launched ${result.launched.length} trials in round ${result.roundNumber}.`,
        );
    });

  group
    .command("continue <id>")
    .description(
      "Reopen a finished optimization for another round against its fixed baseline",
    )
    .option("--yes", "skip the confirmation")
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      await confirmOrAbort(
        `Reopen ${id} for another round? Saved trials still require launch.`,
        opts.yes,
      );
      const detail = await createClient().post<Detail>(
        `${itemPath(resolveOrg(cmd), id)}/continue`,
        {},
      );
      if (resolveOutput(cmd) === "json") printJson(detail);
      else printDetail(detail);
    });

  group
    .command("activity <id>")
    .description("Read the optimization's decision log")
    .option("--after <timestamp>", "entries after this ISO timestamp")
    .option("--limit <n>", "maximum entries (1–500)")
    .action(
      async (
        id: string,
        opts: { after?: string; limit?: string },
        cmd: Command,
      ) => {
        const res = await createClient().get<{
          items: {
            createdAt: string;
            kind: string;
            summary: string;
            actorName: string | null;
          }[];
        }>(`${itemPath(resolveOrg(cmd), id)}/activity`, {
          after: opts.after,
          limit: parseCount(opts.limit, "--limit", 500),
        });
        if (resolveOutput(cmd) === "json") printJson(res.items);
        else
          printItems(
            res.items.map((row) => ({
              at: row.createdAt,
              kind: row.kind,
              actor: row.actorName ?? "Worker",
              summary: row.summary,
            })),
            "table",
          );
      },
    );

  group
    .command("chat <id>")
    .description("Resolve your optimization chat and print its URL path")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const res = await createClient().post<optimizations.ResolveChatResponse>(
        `${itemPath(resolveOrg(cmd), id)}/chat`,
        {},
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else console.log(res.href);
    });

  group
    .command("rm <id>")
    .description("Delete an optimization, retaining billed session history")
    .option("--yes", "skip the confirmation")
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      await confirmOrAbort(
        `Delete optimization ${id}, its rounds, trials, and activity? Session history is kept.`,
        opts.yes,
      );
      await createClient().delete(itemPath(resolveOrg(cmd), id));
      if (resolveOutput(cmd) === "json") printJson({ deleted: id });
      else console.log(`Deleted ${id}.`);
    });

  group
    .command("complete <id>")
    .description("Complete an optimization: it reads as Finished, not canceled")
    .option("--adopt <trialId>", "mark this settled trial as the winner")
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        opts: { adopt?: string; yes?: boolean },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        await confirmOrAbort(
          `Complete optimization ${id}? No further rounds run; unspent credits are released.`,
          opts.yes,
        );
        const detail = await createClient().post<Detail>(
          `${itemPath(org, id)}/complete`,
          opts.adopt ? { adoptTrialId: opts.adopt } : {},
        );
        if (resolveOutput(cmd) === "json") printJson(detail);
        else
          console.log(`${detail.id}: ${detail.status} (${detail.stopReason})`);
      },
    );

  group
    .command("watch <id>")
    .description(
      `Follow until finished or awaiting input (exit ${NEEDS_INPUT_EXIT} when it needs you); --follow keeps waiting`,
    )
    .option("--interval <seconds>", "poll interval (default 15)")
    .option("--follow", "keep polling while awaiting authoring or launch")
    .action(
      async (
        id: string,
        opts: { interval?: string; follow?: boolean },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const client = createClient();
        const interval = Number(opts.interval ?? 15);
        if (!Number.isFinite(interval) || interval <= 0)
          throw new CliError(
            "usage",
            "--interval must be a positive finite number",
          );
        const intervalMs = Math.max(interval * 1000, 2000);
        let last = "";
        for (;;) {
          const detail = await client.get<Detail>(itemPath(org, id));
          const trials = detail.rounds.flatMap((round) => round.trials);
          const failed = trials.reduce(
            (sum, trial) => sum + trial.failedSessions,
            0,
          );
          const line = `${detail.status}${detail.stopReason ? ` (${detail.stopReason})` : ""} · round ${detail.round} · ${pct(detail.before)} → ${pct(detail.after)} · ${detail.creditsSpent} credits spent${failed ? ` · ${failed} failed session${failed === 1 ? "" : "s"}` : ""} · ${
            trials
              .filter((t) => t.status === "RUNNING")
              .map((t) => t.key)
              .join(",") || "idle"
          }`;
          if (line !== last) {
            last = line;
            console.error(line);
          }
          const needsInput = awaitingInput(detail);
          if (watchStops(detail, !!opts.follow)) {
            if (resolveOutput(cmd) === "json") printJson(detail);
            else printDetail(detail);
            if (needsInput) process.exitCode = NEEDS_INPUT_EXIT;
            return;
          }
          await sleep(intervalMs);
        }
      },
    );

  group
    .command("authoring <id>")
    .description(
      "What the next round may change: exposed surfaces, CLI targets, baseline run evidence, revision",
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      printJson(
        await createClient().get(`${itemPath(resolveOrg(cmd), id)}/authoring`),
      );
    });

  group
    .command("cli-change <id>")
    .description(
      "Validate and seal v3 {schemaVersion:3, target, rules, shippingIntent}; use the output as intervention.after in a round file. Saves nothing",
    )
    .requiredOption("--file <path>", "the change JSON; '-' for stdin")
    .action(async (id: string, opts: { file: string }, cmd: Command) => {
      printJson(
        await createClient().post(
          `${itemPath(resolveOrg(cmd), id)}/cli-changes`,
          readObject(opts.file),
        ),
      );
    });

  const round = group
    .command("round")
    .description(
      "Preview and save the round waiting to launch. A round file is {revision, trials: [{trial: {title, hypothesis, lever, intervention}, files?}]}; revision comes from `authoring`",
    );

  round
    .command("preview <id>")
    .description("Validate a round file and print its diff and previewDigest")
    .requiredOption("--file <path>", "the round JSON; '-' for stdin")
    .action(async (id: string, opts: { file: string }, cmd: Command) => {
      const preview = await createClient().post<RoundPreview>(
        `${itemPath(resolveOrg(cmd), id)}/rounds/current/preview`,
        readObject(opts.file),
      );
      if (resolveOutput(cmd) === "json") printJson(preview);
      else printRoundPreview(preview);
    });

  round
    .command("save <id>")
    .description(
      "Save a previewed round as drafts, replacing every pending draft. Never launches",
    )
    .requiredOption("--file <path>", "the round JSON you previewed")
    .requiredOption("--digest <digest>", "previewDigest from `round preview`")
    .action(
      async (
        id: string,
        opts: { file: string; digest: string },
        cmd: Command,
      ) => {
        const result = await createClient().put<RoundSaved>(
          `${itemPath(resolveOrg(cmd), id)}/rounds/current`,
          { ...readObject(opts.file), previewDigest: opts.digest },
        );
        if (resolveOutput(cmd) === "json") printJson(result);
        else
          for (const trial of result.trials)
            console.log(`Saved ${trial.key} "${trial.title}"`);
      },
    );

  const trials = group
    .command("trials")
    .description("List, author, and run trials");

  trials
    .command("list <id>")
    .description("Every trial of an optimization with score and verdict")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const res = await createClient().get<optimizations.ListTrialsResponse>(
        `${itemPath(org, id)}/trials`,
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else printItems(res.items.map(trialRow), "table");
    });

  trials
    .command("add <id>")
    .description(
      "Save an authored draft trial; --launch also runs it (spends credits)",
    )
    .option(
      "--file <path>",
      "authored trial JSON, as `trials template` prints it: one {trial, files?} or an array; '-' for stdin",
    )
    .option("--pick <n>", "which trial to take from an array (default 1)")
    .option("--title <text>", "what the change is")
    .option("--hypothesis <text>", "why it should help")
    .option("--lever <lever>", "DOCS, MARKETING_SITE, SKILL, SDK, CLI")
    .option(
      "--edit-skill <id>",
      "skill version to rewrite (with --skill-dir); see `gauge optimizations skill-files <id>`",
    )
    .option(
      "--skill-dir <path>",
      "local directory holding the complete edited bundle, SKILL.md included",
    )
    .option("--page <url>", "docs page to rewrite (with --body-file)")
    .option("--body-file <path>", "the rewritten page body; '-' for stdin")
    .option(
      "--launch",
      "run the trial after saving (spends credits); otherwise save a draft",
    )
    .option(
      "--idempotency-key <key>",
      "a retry with this key returns the first call's trial instead of a second one",
    )
    .option("--yes", "skip the confirmation")
    .action(
      async (id: string, opts: TrialOpts & { yes?: boolean }, cmd: Command) => {
        const org = resolveOrg(cmd);
        const body = trialBodyFromOpts(opts);
        if (body.launch !== false)
          await confirmOrAbort(
            `Run trial "${body.trial.title}" on ${id} now? Spends credits.`,
            opts.yes,
          );
        const result = await createClient().post<{
          trial: Trial;
          launch: optimizations.LaunchTrialResponse | null;
          replayed?: boolean;
        }>(`${itemPath(org, id)}/trials`, body);
        if (resolveOutput(cmd) === "json") printJson(result);
        else if (result.replayed)
          console.log(
            `Replayed ${result.trial.key} "${result.trial.title}" (${result.trial.status}) — this key already authored it`,
          );
        else
          console.log(
            `${result.launch ? "Running" : "Saved"} ${result.trial.key} "${result.trial.title}"${result.launch ? ` — ${result.launch.runIds.length} session${result.launch.runIds.length === 1 ? "" : "s"}` : ""}`,
          );
      },
    );

  trials
    .command("template")
    .description("Print a trial JSON skeleton for `trials add --file`")
    .requiredOption("--kind <kind>", "EDIT_SKILL or REWRITE_DOCS")
    .action((opts: { kind: string }) => {
      printJson(trialTemplate(opts.kind));
    });

  trials
    .command("run <id> <trialId>")
    .description("Run a draft trial now (spends credits)")
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        trialId: string,
        opts: { yes?: boolean },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        await confirmOrAbort(
          `Run trial ${trialId} now? Spends credits.`,
          opts.yes,
        );
        const result =
          await createClient().post<optimizations.LaunchTrialResponse>(
            `${trialPath(org, id, trialId)}/launch`,
            {},
          );
        if (resolveOutput(cmd) === "json") printJson(result);
        else
          console.log(
            `Started ${result.runIds.length} session${result.runIds.length === 1 ? "" : "s"} for ${trialId}`,
          );
      },
    );

  trials
    .command("rm <id> <trialId>")
    .description("Drop one draft trial from the round waiting to launch")
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        trialId: string,
        opts: { yes?: boolean },
        cmd: Command,
      ) => {
        await confirmOrAbort(`Remove draft ${trialId} from ${id}?`, opts.yes);
        const detail = await createClient().delete<Detail>(
          trialPath(resolveOrg(cmd), id, trialId),
        );
        if (resolveOutput(cmd) === "json") printJson(detail);
        else console.log(`Removed ${trialId}.`);
      },
    );

  group
    .command("trial <id> <trialId>")
    .description("One trial by id or key (B0, R1.1, …) with its sessions")
    .action(
      async (id: string, trialId: string, _opts: unknown, cmd: Command) => {
        const org = resolveOrg(cmd);
        const trial = await createClient().get<Trial>(
          trialPath(org, id, trialId),
        );
        if (resolveOutput(cmd) === "json") printJson(trial);
        else printTrial(trial);
      },
    );

  group
    .command("change <id> <trialId>")
    .description("The change a trial made: before and after text per document")
    .option("--body", "print only the pasteable page body of a docs rewrite")
    .action(
      async (
        id: string,
        trialId: string,
        opts: { body?: boolean },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        const content = await createClient().get<TrialContent>(
          `${trialPath(org, id, trialId)}/content`,
        );
        if (resolveOutput(cmd) === "json") printJson(content);
        else if (opts.body) {
          if (content.copyableBody === null)
            throw new CliError(
              "usage",
              "this trial is not a docs rewrite; drop --body",
            );
          console.log(content.copyableBody);
        } else printChange(content);
      },
    );

  group
    .command("adopt <id> <trialId>")
    .description(
      "Mark a settled trial as the winner without changing the baseline",
    )
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        trialId: string,
        opts: { yes?: boolean },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        await confirmOrAbort(
          `Mark ${trialId} as the winner on ${id}?`,
          opts.yes,
        );
        const detail = await createClient().post<Detail>(
          `${trialPath(org, id, trialId)}/adopt`,
          {},
        );
        if (resolveOutput(cmd) === "json") printJson(detail);
        else console.log(`Marked ${trialId} as the winner.`);
      },
    );

  group
    .command("handoff <id>")
    .description(
      "The instructions a coding agent follows to land the winning trial in your source, as the web app's Copy instructions for agent",
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const handoff =
        await createClient().get<optimizations.OptimizationHandoff>(
          `${itemPath(resolveOrg(cmd), id)}/handoff`,
        );
      if (resolveOutput(cmd) === "json") printJson(handoff);
      else process.stdout.write(handoff.prompt);
    });

  group
    .command("skill-files <versionId>")
    .description(
      "The text files of a skill version, the base a skill-edit trial edits",
    )
    .action(async (versionId: string, _opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const res = await createClient().get<optimizations.SkillFilesResponse>(
        `${basePath(org)}/skill-versions/${encodeURIComponent(versionId)}`,
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else
        for (const file of res.files) {
          console.log(`=== ${file.path}`);
          console.log(file.body);
        }
    });

  group
    .command("page <id>")
    .description(
      "The baseline body of a docs page, the base a docs-rewrite trial edits",
    )
    .requiredOption("--url <url>", "the page URL")
    .action(async (id: string, opts: { url: string }, cmd: Command) => {
      const org = resolveOrg(cmd);
      const res = await createClient().get<optimizations.PageBodyResponse>(
        `${itemPath(org, id)}/page`,
        { url: opts.url },
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else {
        if (res.source === "scrape")
          console.error(
            "Source: fresh scrape; this is not the captured baseline response.",
          );
        else if (res.source === "none")
          console.error("No page body is available.");
        console.log(res.body);
      }
    });
}
