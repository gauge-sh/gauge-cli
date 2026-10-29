import { readFileSync, writeFileSync } from "node:fs";
import type { optimizations } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { confirmOrAbort } from "../lib/confirm";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type Summary =
  optimizations.OptimizationWire<optimizations.OptimizationSummary>;
type Detail = optimizations.OptimizationWire<optimizations.OptimizationDetail>;
type LaunchView = optimizations.OptimizationLaunchView;
type LaunchDetail = optimizations.OptimizationLaunchDetail;
type SubjectRef = optimizations.OptimizationSubjectRef;
type FileEdit = optimizations.WriteOptimizationFileBody;
type FileSource = optimizations.AddOptimizationFileBody;
type TreeFile = optimizations.OptimizationFile;
type Checkpoint = optimizations.OptimizationCheckpointView;
type RestorePoint = optimizations.OptimizationRestorePoint;
type LaunchResult = {
  launchId: string;
  changed: string[];
  batches: {
    batchId: string;
    sourceRunId: string;
    runIds: string[];
    restoredFrom: { checkpointId: string; rerunId: string; seq: number } | null;
    warnings: string[];
  }[];
};

const STATUSES = ["OPEN", "DONE", "ARCHIVED"] as const;
const TERMINAL_RUN = new Set(["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELED"]);

function basePath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/optimizations`;
}

function itemPath(org: string, id: string): string {
  return `${basePath(org)}/${encodeURIComponent(id)}`;
}

function readText(path: string): string {
  return readFileSync(path === "-" ? 0 : path, "utf8");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path));
  } catch {
    throw new CliError("usage", `${path} must contain valid JSON`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function parseCount(
  raw: string | undefined,
  flag: string,
  max: number,
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

export function parseStatus(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const status = raw.trim().toUpperCase();
  if (!(STATUSES as readonly string[]).includes(status))
    throw new CliError(
      "usage",
      `unknown status "${raw}" (expected ${STATUSES.join(", ")})`,
    );
  return status;
}

type SubjectOpts = {
  issue?: string;
  finding?: string;
  run?: string;
  goal?: string;
};

export function parseSubjectRef(opts: SubjectOpts): SubjectRef {
  if ([opts.issue, opts.finding, opts.goal].filter(Boolean).length !== 1)
    throw new CliError(
      "usage",
      "pass one of --issue <id>, --finding <id> --run <runId>, or --goal <text>",
    );
  if (opts.run && !opts.finding)
    throw new CliError("usage", "--run only applies with --finding");
  if (opts.issue) return { kind: "issue", issueId: opts.issue };
  if (opts.finding) {
    if (!opts.run) throw new CliError("usage", "--finding needs --run <runId>");
    return { kind: "finding", observationId: opts.finding, runId: opts.run };
  }
  return { kind: "free", text: opts.goal as string };
}

type FileWriteOpts = {
  page?: string;
  skill?: string;
  path?: string;
  cli?: string;
  from?: string;
  delete?: boolean;
  contentType?: string;
};

export function fileEditFromOpts(
  opts: FileWriteOpts,
  read: (path: string) => string = readText,
): FileEdit {
  if ([opts.page, opts.skill, opts.cli].filter(Boolean).length !== 1)
    throw new CliError(
      "usage",
      "pass one of --page <url>, --skill <name> --path <path>, or --cli <package>",
    );
  if (opts.delete && !opts.skill)
    throw new CliError("usage", "--delete removes one path from a skill");
  if (opts.path && !opts.skill)
    throw new CliError("usage", "--path only applies with --skill");
  if (opts.contentType && !opts.page)
    throw new CliError("usage", "--content-type only applies with --page");
  if (opts.delete && opts.from)
    throw new CliError("usage", "pass --delete or --from, not both");
  if (!opts.delete && !opts.from)
    throw new CliError("usage", "--from <file> is required ('-' for stdin)");
  const from = opts.from as string;
  if (opts.page)
    return {
      kind: "page",
      url: opts.page,
      body: read(from),
      ...(opts.contentType ? { contentType: opts.contentType } : {}),
    };
  if (opts.skill) {
    if (!opts.path)
      throw new CliError(
        "usage",
        "--skill needs --path <path inside the skill>",
      );
    return {
      kind: "skill",
      name: opts.skill,
      path: opts.path,
      body: opts.delete ? null : read(from),
    };
  }
  let rules: unknown;
  try {
    rules = JSON.parse(read(from));
  } catch {
    throw new CliError("usage", "--from must contain CLI rules as JSON");
  }
  return {
    kind: "cli",
    package: opts.cli as string,
    rules: rules as Extract<FileEdit, { kind: "cli" }>["rules"],
  };
}

type FileAddOpts = { page?: string; skill?: string; cli?: boolean };

export function fileSourceFromOpts(opts: FileAddOpts): FileSource {
  if ([opts.page, opts.skill, opts.cli].filter(Boolean).length !== 1)
    throw new CliError(
      "usage",
      "pass one of --page <url>, --skill <name>, or --cli",
    );
  if (opts.page) return { kind: "page", url: opts.page };
  if (opts.skill) return { kind: "skill", name: opts.skill };
  return { kind: "cli" };
}

export function latestLaunch<T extends { number: number }>(
  launches: T[],
): T | undefined {
  return launches.reduce<T | undefined>(
    (latest, launch) =>
      !latest || launch.number > latest.number ? launch : latest,
    undefined,
  );
}

/** Analysis only follows a successful rerun, so failed reruns settle unanalyzed. */
export function launchSettled(launch: Pick<LaunchView, "runs">): boolean {
  return launch.runs.every(
    (run) =>
      TERMINAL_RUN.has(run.status) &&
      (run.status !== "SUCCEEDED" || run.analyzed),
  );
}

function subjectLine(subject: Detail["subject"]): string {
  switch (subject.kind) {
    case "issue":
      return `issue "${subject.title}" (${subject.issueId})`;
    case "finding":
      return `finding "${subject.label}" on run ${subject.runId}`;
    case "free":
      return `goal "${subject.text}"`;
  }
}

function toRow(o: Summary) {
  return {
    id: o.id,
    title: o.title.length > 48 ? `${o.title.slice(0, 45)}...` : o.title,
    status: o.status,
    subject: o.subject.kind,
    changed: o.changed,
    launches: o.launches,
    updated: o.updatedAt,
  };
}

function fileRow(key: string, file: TreeFile, change: string | undefined) {
  return {
    key,
    change: change ?? "",
    size:
      file.kind === "page"
        ? `${file.body.length} chars`
        : file.kind === "skill"
          ? plural(Object.keys(file.files).length, "file")
          : plural(file.rules.rules.length, "rule"),
  };
}

function launchProgress(launch: LaunchView): string {
  const done = launch.runs.filter((run) => TERMINAL_RUN.has(run.status));
  const analyzed = launch.runs.filter((run) => run.analyzed);
  return `${done.length}/${launch.runs.length} finished, ${analyzed.length} analyzed`;
}

function launchRow(launch: LaunchView) {
  return {
    id: launch.id,
    number: launch.number,
    reruns: launchProgress(launch),
    changed: launch.changed.length,
    note: launch.note ?? "",
    created: launch.createdAt,
  };
}

function printDetail(o: Detail): void {
  console.log(`id:       ${o.id}`);
  console.log(`title:    ${o.title}`);
  console.log(`status:   ${o.status}`);
  console.log(`subject:  ${subjectLine(o.subject)}`);
  console.log(`sources:  ${o.sourceRunIds.join(", ") || "(none)"}`);
  const changes = new Map(o.changes.map((c) => [c.key, c.status]));
  const files = Object.entries(o.head.files);
  console.log(`files:    ${files.length ? "" : "(empty tree)"}`);
  if (files.length)
    printItems(
      files.map(([key, file]) => fileRow(key, file, changes.get(key))),
      "table",
    );
  for (const [key, change] of changes)
    if (change === "removed") console.log(`  ${key}: removed`);
  console.log(`launches: ${o.launchList.length ? "" : "(none)"}`);
  if (o.launchList.length) printItems(o.launchList.map(launchRow), "table");
  if (o.result) console.log(`result:   ${o.result.summary}`);
}

function printFile(file: TreeFile, path: string | undefined): void {
  if (file.kind === "page") return void console.log(file.body);
  if (file.kind === "cli") return printJson(file.rules);
  if (path) {
    const body = file.files[path];
    if (body === undefined)
      throw new CliError("not_found", `no ${path} in skill ${file.name}`);
    return void console.log(body);
  }
  for (const [name, body] of Object.entries(file.files)) {
    console.log(`=== ${name}`);
    console.log(body);
  }
}

function printLaunch(launch: LaunchDetail): void {
  console.log(
    `launch ${launch.number} (${launch.id})${launch.note ? `: ${launch.note}` : ""}`,
  );
  console.log(`changed: ${launch.changed.join(", ") || "(nothing)"}`);
  for (const run of launch.runs) {
    console.log(
      `\n${run.id} rerun of ${run.sourceRunId ?? "?"}: ${run.status}, ${run.agent} ${run.model}`,
    );
    if (run.restoredFrom)
      console.log(
        `  restored at seq ${run.restoredFrom.seq} (${run.restoredFrom.checkpointId}); cost and time cover only the part after the restore`,
      );
    if (!run.findings) {
      console.log("  not analyzed");
      continue;
    }
    const now = new Set(run.findings.map((f) => f.label));
    const before = new Set(run.sourceFindings.map((f) => f.label));
    for (const f of run.sourceFindings)
      console.log(
        `  ${now.has(f.label) ? "returned" : "resolved"}    ${f.label}`,
      );
    for (const f of run.findings)
      if (!before.has(f.label)) console.log(`  introduced  ${f.label}`);
  }
}

type PageChange = optimizations.OptimizationPageChange;
type WriteResult = {
  key: string;
  chars?: number;
  paths?: string[];
  change?: PageChange;
};
type PageView = {
  url: string;
  rawChars: number;
  text?: string;
  query?: string;
  matches?: number;
  excerpts?: { offset: number; raw: string }[];
  truncated?: boolean;
  hint?: string;
};

export function parseEdits(
  value: unknown,
): { find: string; replace: string }[] {
  const ok =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (edit) =>
        edit &&
        typeof edit === "object" &&
        typeof edit.find === "string" &&
        edit.find.length > 0 &&
        typeof edit.replace === "string",
    );
  if (!ok)
    throw new CliError(
      "usage",
      "--edits must be a JSON array of {find, replace} with non-empty find",
    );
  return (value as { find: string; replace: string }[]).map(
    ({ find, replace }) => ({ find, replace }),
  );
}

function printWrite(res: WriteResult): void {
  if (!res.change) {
    console.log(`Wrote ${res.key}`);
    return;
  }
  const { linesBefore, linesAfter, retainedPercent, hunks } = res.change;
  console.log(
    `Wrote ${res.key}: ${linesBefore} → ${linesAfter} lines, ${retainedPercent ?? "—"}% of the original kept`,
  );
  console.log(hunks);
}

function printPageView(view: PageView): void {
  if (view.text !== undefined) {
    console.log(view.text);
    return;
  }
  console.log(`${view.matches ?? 0} matches for ${JSON.stringify(view.query)}`);
  for (const excerpt of view.excerpts ?? []) {
    console.log(`=== offset ${excerpt.offset}`);
    console.log(excerpt.raw);
  }
  if (view.truncated) console.log("… more matches; search a longer phrase");
  if (view.hint) console.log(view.hint);
}

export function parseRestoreBefore(raw: string): RestorePoint {
  const at = raw.lastIndexOf(":");
  const rerunId = raw.slice(0, at);
  const seq = raw.slice(at + 1);
  if (at <= 0 || !/^-?\d+$/.test(seq))
    throw new CliError(
      "usage",
      `--restore-before takes <rerunId>:<seq>, e.g. run_1:140 (got ${raw})`,
    );
  return { rerunId, seq: Number(seq) };
}

function checkpointRow(cp: Checkpoint) {
  const exposure = [
    ...cp.exposure.surfaces,
    ...(cp.exposure.skillChanged ? ["skill changed"] : []),
    ...(cp.exposureIncomplete ? ["trace incomplete"] : []),
  ];
  return {
    checkpoint: cp.checkpointId,
    source: cp.sourceRunId,
    rerun: cp.rerunId,
    seq: `${cp.seq}/${cp.rerunEventCount}`,
    exposure: exposure.join(", ") || "clean",
    "last step": cp.lastSteps.at(-1) ?? "",
    captured: cp.capturedAt,
  };
}

function printLaunchResult(id: string, res: LaunchResult): void {
  console.log(
    `Launched ${plural(res.batches.flatMap((b) => b.runIds).length, "rerun")} (${res.launchId}) with ${plural(res.changed.length, "changed file")}:`,
  );
  for (const key of res.changed) console.log(`  ${key}`);
  for (const batch of res.batches) {
    const from = batch.restoredFrom;
    console.log(
      from
        ? `${batch.sourceRunId}: restored at seq ${from.seq} of rerun ${from.rerunId} (${from.checkpointId})`
        : `${batch.sourceRunId}: fresh`,
    );
    for (const warning of batch.warnings) console.log(`  ! ${warning}`);
  }
  console.log(`Follow with \`gauge optimizations watch ${id}\`.`);
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("optimizations")).description(
    "Hill climb your agent surfaces: edit the pages, skills, and CLI rules agent sessions used, rerun those sessions, and compare findings",
  );

  group
    .command("list")
    .description("List the org's optimizations, newest activity first")
    .option("--status <status>", STATUSES.join(", "))
    .option("--limit <n>", "max rows (default 50)")
    .action(async (opts: { status?: string; limit?: string }, cmd: Command) => {
      const res = await createClient().get<{ items: Summary[] }>(
        basePath(await resolveOrg(cmd)),
        {
          status: parseStatus(opts.status),
          limit: parseCount(opts.limit, "--limit", 200),
        },
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else printItems(res.items.map(toRow), "table");
    });

  group
    .command("create")
    .description(
      "Open an optimization on an issue, one finding, or a goal; the tree starts empty",
    )
    .option("--issue <id>", "an issue id from `gauge issues list`")
    .option(
      "--finding <id>",
      "a finding id from `gauge run insight <run> -o json`; needs --run",
    )
    .option("--run <runId>", "the run the finding is on")
    .option(
      "--goal <text>",
      "free text; starts with no sessions, attach them with `sessions add`",
    )
    .option("--title <title>", "name (default: from the subject)")
    .action(async (opts: SubjectOpts & { title?: string }, cmd: Command) => {
      const detail = await createClient().post<Detail>(
        basePath(await resolveOrg(cmd)),
        {
          subject: parseSubjectRef(opts),
          ...(opts.title ? { title: opts.title } : {}),
        },
      );
      if (resolveOutput(cmd) === "json") printJson(detail);
      else
        console.log(
          detail.sourceRunIds.length
            ? `Opened ${detail.id} "${detail.title}" on ${plural(detail.sourceRunIds.length, "source session")}. Next: \`gauge optimizations authoring ${detail.id}\`.`
            : `Opened ${detail.id} "${detail.title}" with no sessions. Next: \`gauge optimizations sessions add ${detail.id} <runId...>\`.`,
        );
    });

  group
    .command("get <id>")
    .description("One optimization: subject, source runs, tree, and launches")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const detail = await createClient().get<Detail>(
        itemPath(await resolveOrg(cmd), id),
      );
      if (resolveOutput(cmd) === "json") printJson(detail);
      else printDetail(detail);
    });

  group
    .command("authoring <id>")
    .description(
      "Authoring guidance: the source sessions' findings, the tree, and the editing practices to follow",
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const res = await createClient().get<{ guidance: string }>(
        `${itemPath(await resolveOrg(cmd), id)}/authoring`,
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else console.log(res.guidance);
    });

  group
    .command("sessions")
    .description("Attach sessions an optimization can rerun")
    .command("add <id> <runIds...>")
    .description(
      "Attach sessions to rerun, up to 12 in all; a goal starts with none. Optimization reruns cannot be sources",
    )
    .action(async (id: string, runIds: string[], _opts: unknown, cmd: Command) => {
      const res = await createClient().post<{
        sourceRunIds: string[];
        added: string[];
      }>(`${itemPath(await resolveOrg(cmd), id)}/sessions`, { runIds });
      if (resolveOutput(cmd) === "json") printJson(res);
      else
        console.log(
          `Attached ${plural(res.added.length, "session")}; ${id} has ${plural(res.sourceRunIds.length, "source session")}.`,
        );
    });

  const file = group
    .command("file")
    .description("Read and edit the files in an optimization's tree");

  file
    .command("read <id> <key>")
    .description(
      "Print one file by tree key: a page's exact source (--text for readable text, --query for the source around a match), a skill (or one --path in it), or CLI rules",
    )
    .option("--text", "page only: readable text instead of the source")
    .option(
      "--query <text>",
      "page only: the exact source around each match, to copy into file edit",
    )
    .option("--path <path>", "one file inside a skill")
    .option("--out <file>", "save the page source or skill --path to a file")
    .action(
      async (
        id: string,
        key: string,
        opts: { text?: boolean; query?: string; path?: string; out?: string },
        cmd: Command,
      ) => {
        const path = `${itemPath(await resolveOrg(cmd), id)}/files`;
        if (opts.text || opts.query) {
          if (opts.out)
            throw new CliError("usage", "--out saves the stored file only");
          const view = await createClient().get<PageView>(path, {
            key,
            ...(opts.query ? { query: opts.query } : { view: "text" }),
          });
          if (resolveOutput(cmd) === "json") printJson(view);
          else printPageView(view);
          return;
        }
        const res = await createClient().get<TreeFile>(path, { key });
        if (opts.out) {
          const body =
            res.kind === "page"
              ? res.body
              : res.kind === "skill" && opts.path
                ? res.files[opts.path]
                : undefined;
          if (body === undefined)
            throw new CliError(
              "usage",
              "--out saves a page source or one skill --path",
            );
          writeFileSync(opts.out, body);
          console.error(`Saved ${opts.out}`);
        } else if (resolveOutput(cmd) === "json") printJson(res);
        else printFile(res, opts.path);
      },
    );

  file
    .command("edit <id>")
    .description(
      "Edit a page in the tree with find/replace on its exact source; every byte outside the edits stays. Each find must appear once; all edits apply or none do",
    )
    .requiredOption("--page <url>", "the page URL")
    .requiredOption(
      "--edits <file>",
      "JSON [{find, replace}]; copy find text from `file read --query`; '-' for stdin",
    )
    .action(
      async (
        id: string,
        opts: { page: string; edits: string },
        cmd: Command,
      ) => {
        const res = await createClient().patch<WriteResult>(
          `${itemPath(await resolveOrg(cmd), id)}/files`,
          { url: opts.page, edits: parseEdits(readJson(opts.edits)) },
        );
        if (resolveOutput(cmd) === "json") printJson(res);
        else printWrite(res);
      },
    );

  file
    .command("add <id>")
    .description(
      "Copy an original into the tree before you edit it: a page a source session read (else the live page), a staged skill, or the CLI rules",
    )
    .option("--page <url>", "a page by URL")
    .option("--skill <name>", "a skill a source session staged")
    .option("--cli", "the CLI rules a source session ran with")
    .action(async (id: string, opts: FileAddOpts, cmd: Command) => {
      const res = await createClient().post<{ key: string; origin: string }>(
        `${itemPath(await resolveOrg(cmd), id)}/files`,
        fileSourceFromOpts(opts),
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else console.log(`Added ${res.key} (from ${res.origin})`);
    });

  file
    .command("write <id>")
    .description(
      "Write a new page or rewrite a whole one, one skill file, or the CLI rules; to change part of a page, use file edit",
    )
    .option("--page <url>", "the page URL; --from holds the complete body")
    .option("--content-type <type>", "the page content type (default: keep)")
    .option("--skill <name>", "the skill; needs --path")
    .option("--path <path>", "the file inside the skill, e.g. SKILL.md")
    .option("--delete", "remove --path from the skill")
    .option(
      "--cli <package>",
      "the CLI package; --from holds {schemaVersion: 3, target, rules, shippingIntent}",
    )
    .option("--from <file>", "the new content; '-' for stdin")
    .action(async (id: string, opts: FileWriteOpts, cmd: Command) => {
      const res = await createClient().put<WriteResult>(
        `${itemPath(await resolveOrg(cmd), id)}/files`,
        fileEditFromOpts(opts),
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else printWrite(res);
    });

  file
    .command("rm <id> <key>")
    .description(
      "Drop a file from the tree; reruns use what the source session had",
    )
    .action(async (id: string, key: string, _opts: unknown, cmd: Command) => {
      const res = await createClient().delete<{ removed: string }>(
        `${itemPath(await resolveOrg(cmd), id)}/files`,
        { key },
      );
      if (resolveOutput(cmd) === "json") printJson(res);
      else console.log(`Removed ${res.removed}`);
    });

  group
    .command("notes <id>")
    .description(
      "Print the working notes, or replace them with --from: markdown the user reads beside the chat",
    )
    .option("--from <file>", "the complete notes; '-' for stdin")
    .action(async (id: string, opts: { from?: string }, cmd: Command) => {
      const path = itemPath(await resolveOrg(cmd), id);
      const client = createClient();
      const detail = opts.from
        ? await client.patch<Detail>(path, { notes: readText(opts.from) })
        : await client.get<Detail>(path);
      if (resolveOutput(cmd) === "json") printJson({ notes: detail.notes });
      else if (opts.from)
        console.log(`Saved notes (${detail.notes.length} chars)`);
      else console.log(detail.notes || "(no notes)");
    });

  group
    .command("launch <id>")
    .description(
      "Rerun the source sessions with the tree injected; each rerun restores from the deepest checkpoint before any changed surface, or starts fresh",
    )
    .option("--run <runId...>", "rerun only these source runs")
    .option("--note <text>", "one line on what this launch tests")
    .option(
      "--restore-before <rerunId:seq...>",
      "restore from the deepest checkpoint at or before this seq of an earlier rerun",
    )
    .option(
      "--checkpoint <checkpointId...>",
      "restore from this checkpoint (see `checkpoints`)",
    )
    .option(
      "--fresh [sourceRunId...]",
      "start from zero: these source runs, or every one",
    )
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        opts: {
          run?: string[];
          note?: string;
          restoreBefore?: string[];
          checkpoint?: string[];
          fresh?: true | string[];
          yes?: boolean;
        },
        cmd: Command,
      ) => {
        const path = itemPath(await resolveOrg(cmd), id);
        await confirmOrAbort(
          `Rerun ${opts.run?.length ? plural(opts.run.length, "source session") : "every source session"} of ${id} with the tree?`,
          opts.yes,
        );
        const client = createClient();
        const restoreAt: RestorePoint[] = [
          ...(opts.checkpoint ?? []).map((checkpointId) => ({ checkpointId })),
          ...(opts.restoreBefore ?? []).map(parseRestoreBefore),
        ];
        const fresh =
          opts.fresh === true
            ? (opts.run ?? (await client.get<Detail>(path)).sourceRunIds)
            : (opts.fresh ?? []);
        const res = await client.post<LaunchResult>(`${path}/launch`, {
          ...(opts.run?.length ? { runIds: opts.run } : {}),
          ...(opts.note ? { note: opts.note } : {}),
          ...(fresh.length
            ? {
                restore: Object.fromEntries(
                  fresh.map((runId) => [runId, "none"]),
                ),
              }
            : {}),
          ...(restoreAt.length ? { restoreAt } : {}),
        });
        if (resolveOutput(cmd) === "json") printJson(res);
        else printLaunchResult(id, res);
      },
    );

  group
    .command("checkpoints <id>")
    .description(
      "Checkpoints captured on fresh reruns, with how far in each is and whether its prefix saw a changed surface",
    )
    .option("--run <sourceRunId>", "only this source run")
    .action(async (id: string, opts: { run?: string }, cmd: Command) => {
      const res = await createClient().get<{ items: Checkpoint[] }>(
        `${itemPath(await resolveOrg(cmd), id)}/checkpoints`,
        { sourceRunId: opts.run },
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else if (!res.items.length) console.log("(no checkpoints)");
      else printItems(res.items.map(checkpointRow), "table");
    });

  group
    .command("launches <id> [launchId]")
    .description(
      "List launches, or one launch's reruns with their findings beside the source findings",
    )
    .action(
      async (
        id: string,
        launchId: string | undefined,
        _opts: unknown,
        cmd: Command,
      ) => {
        const path = itemPath(await resolveOrg(cmd), id);
        const client = createClient();
        if (!launchId) {
          const detail = await client.get<Detail>(path);
          if (resolveOutput(cmd) === "json") printJson(detail.launchList);
          else printItems(detail.launchList.map(launchRow), "table");
          return;
        }
        const launch = await client.get<LaunchDetail>(
          `${path}/launches/${encodeURIComponent(launchId)}`,
        );
        if (resolveOutput(cmd) === "json") printJson(launch);
        else printLaunch(launch);
      },
    );

  group
    .command("watch <id>")
    .description(
      "Wait until the latest launch's reruns finish and are analyzed, then print them",
    )
    .option("--interval <seconds>", "poll interval (default 15)")
    .option("--timeout <minutes>", "give up after this long (default 60)")
    .action(
      async (
        id: string,
        opts: { interval?: string; timeout?: string },
        cmd: Command,
      ) => {
        const path = itemPath(await resolveOrg(cmd), id);
        const client = createClient();
        const interval =
          (parseCount(opts.interval, "--interval", 600) ?? 15) * 1000;
        const timeoutMinutes =
          parseCount(opts.timeout, "--timeout", 1440) ?? 60;
        const deadline = Date.now() + timeoutMinutes * 60_000;
        let last = "";
        for (;;) {
          const detail = await client.get<Detail>(path);
          const latest = latestLaunch(detail.launchList);
          if (!latest) throw new CliError("usage", `${id} has no launches yet`);
          if (launchSettled(latest)) {
            const launch = await client.get<LaunchDetail>(
              `${path}/launches/${encodeURIComponent(latest.id)}`,
            );
            if (resolveOutput(cmd) === "json") printJson(launch);
            else printLaunch(launch);
            return;
          }
          const progress = launchProgress(latest);
          if (progress !== last)
            console.error(`launch ${latest.number}: ${progress}`);
          last = progress;
          if (Date.now() >= deadline)
            throw new CliError(
              "network",
              `Timed out after ${timeoutMinutes} minutes (launch ${latest.number}: ${progress}). Re-run watch, or check \`gauge optimizations launches ${id} ${latest.id}\`.`,
            );
          await sleep(interval);
        }
      },
    );

  group
    .command("finish <id>")
    .description(
      "Close the optimization with its result: summary, changed keys, and findings resolved, returned, and introduced",
    )
    .requiredOption(
      "--from <file>",
      "result JSON: {summary, changed, resolved, returned, introduced}",
    )
    .option("--yes", "skip the confirmation")
    .action(
      async (
        id: string,
        opts: { from: string; yes?: boolean },
        cmd: Command,
      ) => {
        const path = itemPath(await resolveOrg(cmd), id);
        const result = readJson(opts.from);
        await confirmOrAbort(
          `Finish ${id}? Its tree can no longer change.`,
          opts.yes,
        );
        const detail = await createClient().post<Detail>(
          `${path}/finish`,
          result,
        );
        if (resolveOutput(cmd) === "json") printJson(detail);
        else console.log(`Finished ${detail.id} "${detail.title}"`);
      },
    );
}
