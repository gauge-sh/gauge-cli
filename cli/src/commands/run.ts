import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { analysisSubmissionSchema } from "@withgauge/api-schemas/sessionAnalysis";
import {
  localDirectory,
  localMeasurementSpec,
  withLocalStore,
} from "../lib/localMeasurements";
import {
  getLocalAnalysis,
  saveLocalAnalysis,
  renderLocalAnalysisMarkdown,
} from "../lib/localAnalysis";
import {
  localBatchStatus,
  cancelLocal,
  localStatus,
} from "../lib/localLifecycle";
import { join, relative } from "node:path";
import {
  type CancelRunResponse,
  type InsightPass,
  type RegradeRunResponse,
  type RunCompareResponse,
  type RunDetail,
  type RunEvent,
  type RunInsightResponse,
  type RunListItem,
  type RunListResponse,
  runEventSchema,
} from "@withgauge/api-schemas/runs";
import type { runDefinitions, runRequests } from "@withgauge/api-schemas";
import { preferenceSelectionLabel } from "@withgauge/api-schemas/preference";
import { type Command, Option } from "commander";
import {
  applySpec,
  BATTERY_SCHEMA,
  EXAMPLE_SPEC,
  parseSpec,
  readSpecJson,
} from "../lib/batteries";
import {
  CASE_SPEC_SCHEMA,
  type CaseSpec,
  EXAMPLE_CASE_SPEC,
  isCaseSpec,
  parseCaseSpec,
} from "../lib/caseSpec";
import { CliError, createClient } from "../lib/client";
import { confirmOrAbort } from "../lib/confirm";
import { triggeredByLabel } from "../lib/createdBy";
import {
  hostedOnly,
  requireHosted,
  resolveOrg,
  resolveOutput,
} from "../lib/context";
import { runEvalSet } from "../lib/evalSets";
import { collect, once, parseAgents } from "../lib/flags";
import { gaugeState } from "../lib/gaugeState";
import {
  type InputSnapshot,
  loadLocalRunDefinition,
  parseInputBindings,
  uploadLocalInputs,
} from "../lib/localRunInputs";
import { listLocalRuns, type LocalRun, parseSince } from "../lib/localRuns";
import { printItems, printJson, style } from "../lib/output";
import {
  compareLocalRuns,
  compareWarnings,
  localCompareFilter,
  localCompareWarnings,
  parseCompareSide,
  printComparison,
} from "../lib/runCompare";
import {
  listPreferencePromptRuns,
  runPreferencePrompt,
} from "../lib/preferencePrompts";
import {
  analysisNext,
  type LocalBatch,
  type LocalPlan,
  planLocal,
  detachLocal,
  runLocal,
} from "../lib/localExecutor";
import { printEvalVerification, verifyEvals } from "../lib/verifyEvals";

function runPath(id: string): string {
  return `/api/v1/runs/${encodeURIComponent(id)}`;
}

function streamPath(id: string): string {
  return `/api/runs/${encodeURIComponent(id)}/stream`;
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

function fmtUsd(v: number | null | undefined): string {
  return v == null ? "" : `$${v.toFixed(2)}`;
}

function compact(value: unknown, max = 140): string {
  const s =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function toRow(run: RunListItem) {
  const selected = run.selectedProvider?.slug ?? "";
  const observed = run.observedProvider?.slug;
  return {
    id: run.id,
    status: run.status,
    agent: run.agent,
    model: run.modelDisplayName ?? run.resolvedModel ?? run.model,
    provider:
      observed && observed !== selected
        ? `${selected || "?"} → ${observed}`
        : selected || observed || "",
    experiment: run.experiment ?? "",
    revision: run.evalRevision ?? "",
    trial: run.optimizationTrial
      ? `${run.optimizationTrial.key} ${run.optimizationTrial.trialId}`
      : "",
    source: run.triggeredBy?.source ?? "",
    turns: run.turns ?? "",
    cost: fmtUsd(run.usdCost),
    credits: run.creditsCharged ?? "",
    duration: fmtDuration(run.durationMs),
    created: run.createdAt,
    prompt: compact(run.promptSnippet, 48),
  };
}

function toLocalRow(run: LocalRun) {
  return {
    id: run.id,
    status: run.outcome,
    agent: run.agent,
    model: run.model,
    batch: run.batchId,
    eval: run.evalId ?? "",
    turns: run.turns,
    analyzed: run.analyzed ? "yes" : "",
    ended: run.endedAt,
  };
}

function detailLines(run: RunDetail): [string, string][] {
  return [
    ["Id", run.id],
    ["Status", run.status],
    ["Agent", run.agent],
    [
      "Model",
      run.modelDisplayName ||
        run.resolvedModel ||
        run.model ||
        "(platform default)",
    ],
    ["Requested model", run.model || "(platform default)"],
    [
      "Selected provider",
      run.selectedProvider
        ? `${run.selectedProvider.displayName} (${run.selectedProvider.slug})`
        : "—",
    ],
    [
      "Observed provider",
      run.observedProvider
        ? `${run.observedProvider.slug} (${run.observedProvider.source.toLowerCase().replaceAll("_", " ")})`
        : "—",
    ],
    ["Prompt", compact(run.promptText, 120)],
    ["Prompt id", run.promptId],
    ["Batch", run.batchId],
    ["Experiment", run.experiment ?? "—"],
    ["Eval set", run.evalSetId ?? "—"],
    ["Eval revision", run.evalRevision ?? "—"],
    [
      "Optimization trial",
      run.optimizationTrial
        ? `${run.optimizationTrial.key} "${run.optimizationTrial.title}" (${run.optimizationTrial.kind}), trial ${run.optimizationTrial.trialId} in optimization ${run.optimizationTrial.optimizationId}`
        : "—",
    ],
    ["Scenario", run.scenario],
    ["Funding", run.funding],
    [
      "Repo",
      run.repoUrl
        ? `${run.repoUrl}${run.repoRef ? ` @ ${run.repoRef}` : ""}`
        : "—",
    ],
    ["Attempt", String(run.attempt)],
    ["Turns", run.turns == null ? "—" : String(run.turns)],
    ["Triggered by", triggeredByLabel(run.triggeredBy) || "—"],
    ["Cost", fmtUsd(run.usdCost) || "—"],
    ["Credits", run.creditsCharged == null ? "—" : String(run.creditsCharged)],
    ["Duration", fmtDuration(run.durationMs) || "—"],
    ["Exit reason", run.exitReason ?? "—"],
    ["Failure reason", run.failureReason ?? "—"],
    ["Cancel requested", run.cancelRequested ? "yes" : "no"],
    ["Diff", run.hasDiff ? `yes (gauge run diff ${run.id})` : "no"],
    ...run.criterionResults.map((c): [string, string] => [
      `Criterion ${c.name}`,
      c.passed === null ? "not assessed" : c.passed ? "passed" : "failed",
    ]),
    ["Created", run.createdAt],
    ["Started", run.startedAt ?? "—"],
    ["Finished", run.finishedAt ?? "—"],
  ];
}

function passLine(label: string, pass: InsightPass): string {
  const bits: string[] = [pass.status];
  if (pass.model) bits.push(pass.model);
  const cost = fmtUsd(pass.usdCost);
  if (cost) bits.push(cost);
  if (pass.error) bits.push(`error: ${compact(pass.error, 60)}`);
  return `${label.padEnd(20)} ${bits.join("  ")}`;
}

const PASS_LABELS: Record<string, string> = {
  ANALYSIS: "Session analysis",
  CLI_DISCOVERY: "CLI discovery",
  LEVER: "Improvement levers",
  EXPERIMENT_DELTA: "Experiment delta",
};

const INSTALLED: Record<string, string> = {
  NONE: "",
  ATTEMPTED: "attempted",
  CONFIGURED: "configured",
  EXERCISED: "exercised",
};

const check = (value: boolean) => (value ? "yes" : "");

function printInsight(insight: RunInsightResponse): void {
  for (const pass of insight.passes) {
    console.log(passLine(PASS_LABELS[pass.kind] ?? pass.kind, pass));
  }
  const analysis = insight.analysis;
  if (!analysis) {
    console.log(
      insight.decision.status === "SKIPPED"
        ? "\n(skipped)"
        : "\n(no analysis yet)",
    );
    return;
  }
  if (analysis.limitation)
    console.log(`\n${compact(analysis.limitation, 200)}`);

  console.log(`\nFindings (${analysis.observations.length})`);
  for (const finding of analysis.observations) {
    console.log(`  ${finding.kind}: ${finding.label}`);
    console.log(`    ${finding.detail}`);
    console.log(`    Evidence: ${JSON.stringify(finding.evidence)}`);
  }

  console.log(`\nProducts (${analysis.products.length})`);
  if (analysis.products.length > 0)
    printItems(
      analysis.products.map((p) => ({
        product: p.name,
        considered: check(p.considered),
        chosen: check(p.chosen),
        rejected: check(p.rejected),
        installed: INSTALLED[p.installPhase] ?? p.installPhase,
        rank: p.rank ?? "",
        source: p.source.toLowerCase(),
      })),
      "table",
    );

  const delta = insight.experimentDelta as {
    changed?: boolean;
    hypothesisSupported?: string;
    summary?: string;
  } | null;
  if (delta && typeof delta === "object") {
    console.log("\nExperiment delta");
    console.log(
      [
        delta.changed == null ? "" : delta.changed ? "changed" : "no change",
        delta.hypothesisSupported ?? "",
      ]
        .filter(Boolean)
        .join("  "),
    );
    if (delta.summary) console.log(compact(delta.summary, 300));
  }

  console.error("\n(full detail: rerun with -o json)");
}

function parseEvent(data: string): RunEvent | null {
  try {
    const parsed = runEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function formatEventLine(e: RunEvent): string {
  const rec = e as Record<string, unknown>;
  const head = `[t${e.turn}#${e.seq}]`;
  switch (e.type) {
    case "run_meta": {
      const agent = rec.agent as { name?: string; model?: string } | undefined;
      const model = agent?.model ? ` model=${agent.model}` : "";
      return `${head} run_meta agent=${agent?.name ?? "?"}${model}`;
    }
    case "agent_message":
      return `${head} agent: ${compact(rec.text)}`;
    case "reasoning":
      return `${head} reasoning: ${compact(rec.text)}`;
    case "tool_call":
      return `${head} tool_call ${String(rec.name)}: ${compact(rec.input)}`;
    case "tool_result":
      return `${head} tool_result${rec.is_error ? " ERROR" : ""}: ${compact(rec.output, 100)}`;
    case "run_result":
      return `${head} run_result ${String(rec.exit_reason)} turns=${String(rec.turns)} cost=${fmtUsd(rec.cost_usd as number)} duration=${fmtDuration(rec.duration_ms as number)}`;
    default: {
      const {
        run_id: _runId,
        seq: _seq,
        turn: _turn,
        ts: _ts,
        type: _type,
        ...payload
      } = rec;
      return `${head} ${e.type} ${compact(payload)}`;
    }
  }
}

type StreamOptions = {
  idleMs: number;
  firstEventMs: number;
  stopAtLiveMs?: number;
  pollStatus?: boolean;
};

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "SUCCEEDED",
  "FAILED",
  "TIMED_OUT",
  "CANCELED",
]);
const STATUS_POLL_MS = 5_000;
const TERMINAL_DRAIN_MS = 2_000;

async function streamRun(
  id: string,
  json: boolean,
  opts: StreamOptions,
): Promise<void> {
  const client = createClient();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  let gotResult = false;
  let sawData = false;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    if (ms > 0) timer = setTimeout(() => controller.abort(), ms);
  };
  arm(opts.idleMs > 0 ? opts.firstEventMs : 0);
  if (opts.pollStatus) {
    let inFlight = false;
    poller = setInterval(() => {
      if (inFlight || drainTimer) return;
      inFlight = true;
      client
        .get<RunDetail>(runPath(id))
        .then((run) => {
          if (drainTimer || !TERMINAL_STATUSES.has(run.status)) return;
          if (poller) clearInterval(poller);
          drainTimer = setTimeout(() => {
            if (!gotResult) {
              console.error(`Run is ${run.status}; no more events.`);
            }
            controller.abort();
          }, TERMINAL_DRAIN_MS);
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    }, STATUS_POLL_MS);
  }
  try {
    await client.sse(
      streamPath(id),
      (frame) => {
        const event = parseEvent(frame.data);
        if (!event) return;
        sawData = true;
        if (json) console.log(frame.data);
        else console.log(formatEventLine(event));
        if (event.type === "run_result") {
          gotResult = true;
          controller.abort();
        } else if (
          opts.stopAtLiveMs !== undefined &&
          Date.parse(event.ts) >= opts.stopAtLiveMs
        ) {
          gotResult = true;
          controller.abort();
        } else arm(opts.idleMs);
      },
      {
        signal: controller.signal,
        onComment: () => {
          if (!sawData && opts.idleMs > 0) arm(opts.firstEventMs);
        },
      },
    );
  } finally {
    if (timer) clearTimeout(timer);
    if (poller) clearInterval(poller);
    if (drainTimer) clearTimeout(drainTimer);
  }
}

type LaunchOpts = {
  profile?: string;
  eval?: string;
  preference?: string;
  scenario: string[];
  agent: string[];
  samples?: string;
  apply?: string;
  files?: string[];
  input: string[];
  verify?: boolean;
  dryRun?: boolean;
  detach?: boolean;
  runtimeImage?: string;
  gatewayImage?: string;
  requireExperiment?: string;
  schema?: boolean;
  example?: boolean;
  format?: "case" | "battery";
  yes?: boolean;
};

async function loadWorkingTree(
  cmd: Command,
  opts: LaunchOpts,
  upload: boolean,
  spec?: CaseSpec,
): Promise<{
  definition: runDefinitions.RunDefinitionSubmission;
  org: string;
  inputSnapshots: InputSnapshot[];
  unattachedInputs: string[];
}> {
  const loaded = await loadLocalRunDefinition(
    opts.files ?? [],
    opts.input,
    undefined,
    { spec },
  );
  try {
    const org = await resolveOrg(cmd, loaded.org);
    if (upload) await confirmOrAbort("Run these cases now?", opts.yes);
    await uploadLocalInputs(createClient(), org, loaded.uploads);
    return {
      definition: loaded.definition,
      org,
      inputSnapshots: loaded.inputSnapshots,
      unattachedInputs: loaded.unattachedInputs,
    };
  } finally {
    await loaded.cleanup();
  }
}

function printPlan(
  result: runDefinitions.RunDefinitionPlanResponse & {
    inputSnapshots: InputSnapshot[];
    unattachedInputs: string[];
  },
): void {
  console.log(
    `Definition: ${result.source.verification === "LOCAL" ? "current files" : result.source.commit}`,
  );
  console.log(`Expected sessions: ${result.expectedRuns}`);
  for (const item of result.cases)
    console.log(
      `  ${item.path}: ${item.expectedRuns} sessions, ${item.preference ? `${item.preference.kind} preference (advisory)` : `${item.criteriaCount} criteria`}`,
    );
  for (const resource of result.resources) {
    const use = resource.use;
    if (use.type === "npm-package" || use.type === "npm-cli") {
      const install = use.install ?? "environment";
      console.log(`  ${resource.name}: npm package → ${install}`);
      const label =
        install === "environment" ? "Commands on PATH" : "Package commands";
      console.log(
        `    ${label}: ${resource.commands === undefined ? "determined when the input is prepared" : resource.commands.join(", ") || "none (library)"}`,
      );
    } else if (use.type === "binary") {
      console.log(`  ${resource.name}: native executable → ${use.platform}`);
      console.log(
        `    Commands on PATH: ${Object.keys(use.commands).join(", ")}`,
      );
      console.log(
        "    Requires compatible system libraries; Gauge does not install OS packages.",
      );
    } else console.log(`  ${resource.name}: ${use.type}`);
    if (resource.detail) console.log(`    ${resource.detail}`);
  }
  if (result.resources.length) {
    console.log(
      `Inputs: ${result.resources.map((r) => `${r.name} (${r.source}, ${r.readiness})`).join(", ")}`,
    );
    if (!result.canRun)
      console.log("Resolve the input errors before launching.");
  }
  printInputSnapshots(result.inputSnapshots);
  printUnattachedInputs(result.unattachedInputs, false);
}

function printInputSnapshots(snapshots: InputSnapshot[]): void {
  for (const input of snapshots) {
    console.log(
      `  ${input.name}: ${input.source === "working-tree" ? "working-tree snapshot" : "local path override snapshot"}`,
    );
    console.log(`    Source path: ${input.path}`);
    const shown = input.files.slice(0, 10);
    console.log(
      `    Files (${input.fileCount}): ${shown.join(", ")}${input.fileCount > shown.length ? `, and ${input.fileCount - shown.length} more` : ""}`,
    );
    console.log(`    Gauge archive digest: ${input.gaugeArchive.sha256}`);
    console.log(`    Gauge archive bytes: ${input.gaugeArchive.bytes}`);
  }
  if (snapshots.length)
    console.log(
      "Gauge archive hashes identify delivery archives containing the selected files. For npm inputs, the archive contains the .tgz; its hash and size differ from the .tgz itself. Launching again snapshots current files.",
    );
}

function unattachedNote(names: string[], saved: boolean): string {
  return `Not attached: ${names.join(", ")}. ${
    saved
      ? `Saved measurements attach only inputs passed at launch; add ${names.map((name) => `--input ${name}`).join(" ")} to attach.`
      : `The selected cases do not use ${names.length === 1 ? "it" : "them"}.`
  }`;
}

function printUnattachedInputs(names: string[], saved: boolean): void {
  if (names.length) console.log(unattachedNote(names, saved));
}

async function launch(cmd: Command, opts: LaunchOpts): Promise<void> {
  if (opts.profile && gaugeState(cmd).mode !== "local")
    throw new CliError(
      "usage",
      "--profile applies only to local runs. Pass --local.",
    );
  const sources = [
    opts.eval !== undefined && "--eval",
    opts.preference !== undefined && "--preference",
    opts.apply !== undefined && "--apply",
  ].filter((flag): flag is string => Boolean(flag));
  const source = sources[0];
  if (opts.schema || opts.example) {
    const flag = opts.schema ? "--schema" : "--example";
    if (source || (opts.schema && opts.example))
      throw new CliError("usage", `${flag} prints and exits; pass it alone`);
    const cases = opts.format !== "battery";
    if (opts.schema) printJson(cases ? CASE_SPEC_SCHEMA() : BATTERY_SCHEMA());
    else {
      printJson(cases ? EXAMPLE_CASE_SPEC : EXAMPLE_SPEC);
      console.error(
        cases
          ? "\n# Case spec: eval cases as JSON. Save to cases.json, edit, then: gauge run --apply cases.json"
          : "\n# Battery spec: saved prompts and schedules. Save to battery.json, edit, then: gauge run --apply battery.json\n# For eval cases as JSON (criteria, inputs): gauge run --example --format case",
      );
    }
    return;
  }
  if (opts.format)
    throw new CliError("usage", "--format applies with --schema or --example");
  if (sources.length > 1)
    throw new CliError("usage", `pass only one of ${sources.join(", ")}`);
  if (opts.verify) {
    const extra = [
      source,
      opts.dryRun && "--dry-run",
      opts.files !== undefined && "--files",
      opts.input.length > 0 && "--input",
    ].filter(Boolean);
    if (extra.length > 0)
      throw new CliError(
        "usage",
        `--verify checks the eval files in this repo; drop ${extra.join(", ")}`,
      );
    const result = verifyEvals(undefined, {
      local: gaugeState(cmd).mode === "local",
    });
    if (resolveOutput(cmd) === "json") printJson(result);
    else printEvalVerification(result);
    if (result.summary.no > 0) process.exitCode = 1;
    return;
  }
  if (opts.scenario.length > 0 && source !== "--preference")
    throw new CliError("usage", "--scenario applies with --preference only");
  if (
    (opts.agent.length > 0 || opts.samples !== undefined) &&
    source !== "--eval" &&
    source !== "--preference"
  )
    throw new CliError(
      "usage",
      "--agent and --samples apply with --eval or --preference; eval case files set them in their front matter",
    );
  if (opts.files !== undefined && source)
    throw new CliError(
      "usage",
      `--files applies to this repo's eval cases; drop ${source}`,
    );
  if (
    opts.input.length > 0 &&
    (opts.eval !== undefined || opts.preference !== undefined) &&
    gaugeState(cmd).mode !== "local"
  )
    throw new CliError(
      "usage",
      `Hosted saved measurements do not take project inputs; drop --input or pass --local`,
      { hint: "For hosted project inputs, use eval case files or a case spec." },
    );
  if (opts.requireExperiment !== undefined && !opts.apply)
    throw new CliError("usage", "--require-experiment applies with --apply");

  let spec: CaseSpec | undefined;
  if (opts.apply !== undefined) {
    const json = await readSpecJson(opts.apply);
    if (!isCaseSpec(json)) {
      if (gaugeState(cmd).mode === "local")
        throw new CliError(
          "usage",
          "Battery specs (with `prompts`) run on hosted Gauge only.",
          {
            hint: "For local runs, pass a case spec (with `cases`): `gauge run --example --format case`. Or pass --hosted.",
          },
        );
      if (opts.input.length > 0)
        throw new CliError(
          "usage",
          "--input applies to case specs, not battery specs",
        );
      await applySpec(cmd, parseSpec(json), {
        dryRun: opts.dryRun,
        requireExperiment: opts.requireExperiment,
      });
      return;
    }
    if (opts.requireExperiment !== undefined)
      throw new CliError(
        "usage",
        "--require-experiment applies to battery specs, not case specs",
      );
    spec = parseCaseSpec(json);
  }
  if (gaugeState(cmd).mode === "local" && (opts.eval || opts.preference)) {
    const saved = localMeasurementSpec(
      cmd,
      opts.eval ? "eval" : "preference",
      (opts.eval ?? opts.preference)!,
      { ...opts, inputs: [...parseInputBindings(opts.input).keys()] },
    );
    await runLocalCases(cmd, opts, saved.spec, saved.measurement);
    return;
  }
  if (opts.dryRun && source && !spec)
    throw new CliError(
      "usage",
      `--dry-run previews this repo's eval cases or an --apply spec; drop ${source}`,
    );
  if (opts.eval !== undefined || opts.preference !== undefined)
    requireHosted(cmd);
  if (opts.eval !== undefined) {
    await runEvalSet(cmd, opts.eval, opts);
    return;
  }
  if (opts.preference !== undefined) {
    await runPreferencePrompt(cmd, opts.preference, opts);
    return;
  }

  if (gaugeState(cmd).mode === "local") {
    await runLocalCases(cmd, opts, spec);
    return;
  }
  const { definition, org, inputSnapshots, unattachedInputs } =
    await loadWorkingTree(
    cmd,
    opts,
    !opts.dryRun,
    spec,
  );
  const orgPath = `/api/v1/orgs/${encodeURIComponent(org)}/run-definitions`;
  if (opts.dryRun) {
    const result =
      await createClient().post<runDefinitions.RunDefinitionPlanResponse>(
        `${orgPath}/plan`,
        definition,
      );
    const preview = { ...result, inputSnapshots, unattachedInputs };
    if (resolveOutput(cmd) === "json") printJson(preview);
    else printPlan(preview);
    return;
  }
  const result =
    await createClient().post<runDefinitions.RunDefinitionRunResponse>(
      `${orgPath}/run`,
      definition,
    );
  if (resolveOutput(cmd) === "json") printJson(result);
  else {
    console.log(
      `Started ${result.createdRuns}/${result.requestedRuns} sessions in request ${result.runRequestId}`,
    );
    console.log(`Wait: gauge --org ${org} run wait ${result.runRequestId}`);
  }
}

async function runLocalCases(
  cmd: Command,
  opts: LaunchOpts,
  spec?: CaseSpec,
  measurement?: {
    id: string;
    kind: "eval" | "preference";
    revision: number;
    criterionIds?: string[];
  },
): Promise<void> {
  const { root } = gaugeState(cmd);
  if (!root)
    throw new CliError(
      "usage",
      "Local runs need a Gauge workspace. Run `gauge init` in this directory first.",
    );
  const local = await loadLocalRunDefinition(
    opts.files ?? [],
    opts.input,
    process.cwd(),
    { local: true, spec },
  );
  const json = resolveOutput(cmd) === "json";
  if (measurement && local.unattachedInputs.length && !opts.dryRun)
    console.error(`note: ${unattachedNote(local.unattachedInputs, true)}`);
  if (opts.dryRun) {
    try {
      const plan = {
        ...(await planLocal(local.definition, {
          profile: opts.profile,
          runtimeImage: opts.runtimeImage,
          gatewayImage: opts.gatewayImage,
        })),
        inputSnapshots: local.inputSnapshots,
        webFixtures: Object.fromEntries(Object.entries(local.webFixtures).map(([path, { fixture, digest }]) => [path, {
          digest, pages: fixture.pages.map((p) => p.url), scopes: fixture.scopes ?? [], origins: fixture.origins ?? [],
        }])),
        unattachedInputs: local.unattachedInputs,
      };
      if (json) printJson(plan);
      else printLocalPlan(plan, measurement !== undefined);
    } finally {
      await local.cleanup();
    }
    return;
  }
  if (opts.detach) {
    try {
      const detached = await detachLocal(
        local.definition,
        local.uploads,
        join(root, ".gauge"),
        { profile: opts.profile, runtimeImage: opts.runtimeImage, gatewayImage: opts.gatewayImage, measurement },
      );
      if (json) printJson(detached);
      else
        console.log(
          `Batch ${detached.batchId} detached.\nStatus: ${detached.status}\nWait: ${detached.wait}\nStop: ${detached.stop}`,
        );
    } finally {
      await local.cleanup();
    }
    return;
  }
  let batch: LocalBatch;
  try {
    batch = await runLocal(
      local.definition,
      local.uploads,
      join(root, ".gauge"),
      (run) => {
        if (!json)
          console.error(
            `${run.id} ${run.agent} ${run.model} ${run.case}: ${run.outcome}${run.detail ? ` (${run.detail})` : ""}`,
          );
      },
      {
        measurement,
        profile: opts.profile,
        runtimeImage: opts.runtimeImage,
        gatewayImage: opts.gatewayImage,
        onStart: (batchId) =>
          console.error(
            `Batch ${batchId}\nStatus: gauge run status --batch ${batchId} --local\nWait: gauge run wait --batch ${batchId} --local\nStop: gauge run cancel --batch ${batchId} --local`,
          ),
      },
    );
  } finally {
    await local.cleanup();
  }
  if (batch.canceled && !process.exitCode) process.exitCode = 130;
  if (
    !process.exitCode &&
    batch.runs.some((run) => run.outcome !== "completed")
  )
    process.exitCode = 1;
  if (json) {
    printJson(batch);
    return;
  }
  const counts = new Map<string, number>();
  for (const run of batch.runs)
    counts.set(run.outcome, (counts.get(run.outcome) ?? 0) + 1);
  console.log(
    `Batch ${batch.batchId}: ${batch.runs.length} runs. ${[...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ")}.`,
  );
  console.log(
    `Results: .gauge/runs (gauge run list --local --batch ${batch.batchId})`,
  );
  console.log("");
  console.log(batch.next);
}

function printLocalPlan(
  plan: LocalPlan & {
    inputSnapshots: InputSnapshot[];
    unattachedInputs: string[];
  },
  saved: boolean,
): void {
  console.log(
    `Local plan: ${plan.expectedSessions} session${plan.expectedSessions === 1 ? "" : "s"} in local Docker. Nothing started.`,
  );
  console.log(
    `Runtime: ${plan.runtime.reference}${plan.runtime.imageId ? ` (${plan.runtime.imageId})` : ""}. Compatibility probe runs at launch.`,
  );
  if (plan.gateway) console.log(`Gateway: ${plan.gateway.reference}${plan.gateway.imageId ? ` (${plan.gateway.imageId})` : ""}`);
  for (const item of plan.cases)
    console.log(
      `  ${item.path}: ${item.sessions.map((s) => `${s.agent} ${s.model} ×${s.samples}`).join(", ")}; ${item.criteria} criteria`,
    );
  console.log(
    `Inputs: ${plan.inputs.map((i) => `${i.name} (${i.use})`).join(", ") || "none"}`,
  );
  printInputSnapshots(plan.inputSnapshots);
  printUnattachedInputs(plan.unattachedInputs, saved);
  for (const warning of plan.warnings) console.log(`Warning: ${warning}`);
  console.log("Run it: the same command without --dry-run.");
}

const WAIT_POLL_MS = 5_000;
const LOCAL_WAIT_POLL_MS = 2_000;

async function runRequestPath(cmd: Command, id: string): Promise<string> {
  return `/api/v1/orgs/${encodeURIComponent(await resolveOrg(cmd))}/run-requests/${encodeURIComponent(id)}`;
}

function printRunRequest(result: runRequests.RunRequestResponse): void {
  const { counts } = result;
  const measured = counts.measuredRuns ?? 0;
  if (!result.settled)
    console.log(
      `${result.status}: ${counts.terminalRuns}/${counts.createdRuns} sessions finished, ${counts.judgedRuns} judged, ${counts.pendingRuns} pending`,
    );
  else
    console.log(
      measured > 0
        ? `${result.result}: ${measured} preference sessions measured${counts.passedRuns ? `; ${counts.passedRuns} experience sessions passed` : ""}`
        : `${result.result}: ${counts.passedRuns}/${counts.createdRuns} passed sessions (${counts.judgedRuns} judged)`,
    );
  for (const batch of result.batches)
    for (const run of batch.runs)
      console.log(
        `  ${run.id} ${run.agent} ${run.model || "(default)"}: ${
          run.preference
            ? `${preferenceSelectionLabel(run.preference)} (advisory)`
            : run.result
        }`,
      );
  console.log(`Request: ${result.id}`);
}

function failsCheck(result: runRequests.RunRequestResponse): boolean {
  return result.result !== "PASSED" && result.result !== "MEASURED";
}

async function waitForRequest(
  cmd: Command,
  id: string,
  opts: { check?: boolean },
): Promise<void> {
  const path = await runRequestPath(cmd, id);
  const client = createClient();
  const json = resolveOutput(cmd) === "json";
  let lastStatus = "";
  while (true) {
    const result = await client.get<runRequests.RunRequestResponse>(path);
    if (!json && result.status !== lastStatus) {
      console.error(`Run request ${id}: ${result.status}`);
      lastStatus = result.status;
    }
    if (result.settled) {
      if (json) printJson(result);
      else printRunRequest(result);
      if (opts.check && failsCheck(result)) process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

async function waitForLocalBatch(
  cmd: Command,
  gaugeDir: string,
  batchId: string,
  opts: { check?: boolean },
): Promise<void> {
  const json = resolveOutput(cmd) === "json";
  let lastFinished = -1;
  while (true) {
    let batch;
    try {
      batch = await localBatchStatus(gaugeDir, batchId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new CliError("not_found", "Local batch not found");
      throw error;
    }
    const settled = batch.state !== "queued" && batch.state !== "running";
    if (!json && !settled && batch.finishedSessions !== lastFinished) {
      console.error(
        `Batch ${batchId}: ${batch.finishedSessions ?? 0}/${batch.expectedSessions} finished`,
      );
      lastFinished = batch.finishedSessions;
    }
    if (settled) {
      const runs = await localStatus(gaugeDir, { batch: batchId });
      if (json) printJson({ batch, runs, next: analysisNext(batchId) });
      else {
        printLocalStatus(batch, runs);
        console.log(analysisNext(batchId));
      }
      if (
        opts.check &&
        (batch.state !== "completed" ||
          runs.some((run) => run.state !== "completed"))
      )
        process.exitCode = 1;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCAL_WAIT_POLL_MS));
  }
}

function printLocalStatus(
  batch: Awaited<ReturnType<typeof localBatchStatus>> | undefined,
  runs: Awaited<ReturnType<typeof localStatus>>,
): void {
  if (batch)
    console.log(
      `Batch ${batch.batchId}: ${batch.state}; ${batch.finishedSessions ?? 0}/${batch.expectedSessions} finished`,
    );
  for (const run of runs) {
    console.log(
      `${run.id}: ${run.state}${run.cleanupPending ? " (cleanup pending)" : ""}${run.detail ? ` (${run.detail})` : ""}`,
    );
    if (run.stderrLog)
      console.log(`  agent stderr: ${relative(process.cwd(), run.stderrLog)}`);
  }
}

export function register(program: Command): void {
  const run = program
    .command("run")
    .description(
      "Start runs and read them. With no flag: run this repo's eval cases (gauge-cases/) (local: in local Docker)",
    )
    .argument("[command]")
    .usage("[options] [command]")
    .option(
      "--eval <id>",
      "run a saved eval set (see `gauge eval`)",
      once("--eval"),
    )
    .option(
      "--preference <id>",
      "run a saved preference prompt",
      once("--preference"),
    )
    .option(
      "--scenario <scenarioId>",
      "with --preference: run only this scenario (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--agent <agent[:m1,m2]>",
      "with --eval/--preference: run these agents and model pins for this launch only; the stored roster stays (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--samples <n>",
      "with --eval/--preference: sessions per agent and model for this launch only (1-50)",
    )
    .option(
      "--apply <file>",
      'run a JSON spec ("-" for stdin): a case spec (`cases`, both modes) or a battery spec (`prompts`, hosted). See --example',
    )
    .option(
      "--files <paths...>",
      "eval case Markdown paths or globs (default gauge-cases/**/*.md)",
    )
    .option(
      "--input <name[=path]>",
      "attach a gauge.json input; =path or =glob replaces its configured files (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--detach",
      "run a local batch in the background; print status and stop commands",
    )
    .option(
      "--profile <profile>",
      "local credential profile; overrides the default for every target",
    )
    .option(
      "--runtime-image <image>",
      "use a compatible custom Docker image for local runs (tag, digest, or image ID)",
    )
    .option("--gateway-image <image>", "use a compatible custom gateway image for local web fixtures")
    .option("--verify", "check this repo's eval files; start no sessions")
    .option(
      "--dry-run",
      "preview this repo's eval cases or an --apply spec; start no sessions",
    )
    .option(
      "--require-experiment <label>",
      "with --apply: fail unless every target resolves to this experiment label",
    )
    .option("--schema", "print the JSON Schema of an --apply spec and exit")
    .option("--example", "print an example --apply spec and exit")
    .addOption(
      new Option(
        "--format <format>",
        "schema/example format (default: case)",
      ).choices(["case", "battery"]),
    )
    .option("--yes", "skip the confirmation")
    .action(async (arg: string | undefined, opts: LaunchOpts, cmd: Command) => {
      if (arg !== undefined)
        throw new CliError(
          "usage",
          `unknown run command "${arg}". Launch a saved eval set or preference prompt with \`gauge run --eval <id>\` or \`--preference <id>\`; read runs with \`gauge run list\` or \`gauge run get <id> [--logs]\`.`,
        );
      if (
        opts.detach &&
        (gaugeState(cmd).mode !== "local" ||
          opts.dryRun ||
          opts.verify ||
          opts.schema ||
          opts.example)
      )
        throw new CliError("usage", "--detach requires a local run");
      if ((opts.runtimeImage || opts.gatewayImage) && gaugeState(cmd).mode !== "local")
        throw new CliError(
          "usage",
          "--runtime-image and --gateway-image work only on local runs; pass --local",
        );
      await launch(cmd, opts);
    });

  run.hook("preAction", (parent, action) => {
    if (action === parent) return;
    const allowed =
      action.name() === "list" ? ["eval", "preference", "agent"] : [];
    const stray = Object.entries(parent.opts())
      .filter(
        ([key, value]) =>
          !allowed.includes(key) &&
          value !== undefined &&
          !(Array.isArray(value) && value.length === 0),
      )
      .map(
        ([key]) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
    if (stray.length > 0)
      throw new CliError(
        "usage",
        `${stray.join(", ")} ${stray.length === 1 ? "is a launch flag" : "are launch flags"}; \`gauge run ${action.name()}\` does not take ${stray.length === 1 ? "it" : "them"}`,
      );
  });

  run
    .command("list")
    .description(
      "List runs (newest first). Filters combine. --preference <id> lists one prompt's runs with verdicts and takes no other filter. Local: runs in .gauge/",
    )
    .option("--eval <id>", "filter by eval set (local: by eval)")
    .option(
      "--preference <id>",
      "one preference prompt's runs with verdicts (no other filter)",
    )
    .option(
      "--status <status>",
      "filter by status, e.g. running,queued (local: completed,failed)",
    )
    .option("--batch <id>", "filter by batch")
    .option("--prompt <id>", "filter by prompt")
    .option("--experiment <experiment>", "filter by experiment label")
    .option("--since <window>", "e.g. 24h, 7d, or an ISO date")
    .option("--agent <agent>", "filter by agent (local only)")
    .option("--model <model>", "filter by model (local only)")
    .option(
      "--unanalyzed",
      "only runs without a published analysis (local only)",
    )
    .option("--limit <n>", "page size (1-200)", "50")
    .option("--cursor <cursor>", "resume from a previous page's nextCursor")
    .action(async (_opts: unknown, command: Command) => {
      const opts = command.optsWithGlobals<{
        eval?: string;
        preference?: string;
        status?: string;
        batch?: string;
        prompt?: string;
        experiment?: string;
        since?: string;
        agent?: string | string[];
        model?: string;
        unanalyzed?: boolean;
        limit: string;
        cursor?: string;
      }>();
      const agents = [opts.agent ?? []].flat();
      if (agents.length > 1)
        throw new CliError("usage", "pass one --agent to filter by");
      const agent = agents[0];
      const output = resolveOutput(command);
      const state = gaugeState(command);
      if (state.mode === "local") {
        if (opts.prompt || opts.experiment || opts.cursor)
          throw new CliError(
            "usage",
            "Local run list does not support --prompt, --experiment, or --cursor. Use --eval or --preference to select a saved measurement.",
          );
        const items = state.root
          ? listLocalRuns(join(state.root, ".gauge"), {
              batch: opts.batch,
              evalId: opts.eval,
              preferenceId: opts.preference,
              agent: agent ? parseAgents(agent)[0] : undefined,
              model: opts.model,
              outcome: opts.status,
              since: opts.since ? parseSince(opts.since) : undefined,
              analyzed: opts.unanalyzed ? false : undefined,
            }).slice(0, Number(opts.limit))
          : [];
        if (output === "json") printJson({ items });
        else printItems(items.map(toLocalRow), "table");
        return;
      }
      const localOnly = [
        agent !== undefined && "--agent",
        opts.model !== undefined && "--model",
        opts.unanalyzed && "--unanalyzed",
      ].filter(Boolean);
      if (localOnly.length > 0)
        throw new CliError(
          "usage",
          `${localOnly.join(", ")} ${localOnly.length === 1 ? "works" : "work"} only on local runs; pass --local`,
        );
      if (opts.preference !== undefined) {
        const filters = [
          opts.eval !== undefined && "--eval",
          opts.status !== undefined && "--status",
          opts.batch !== undefined && "--batch",
          opts.prompt !== undefined && "--prompt",
          opts.experiment !== undefined && "--experiment",
          opts.since !== undefined && "--since",
        ].filter(Boolean);
        if (filters.length > 0)
          throw new CliError(
            "usage",
            `--preference lists one prompt's runs and takes no other filter; drop ${filters.join(", ")}`,
          );
        await listPreferencePromptRuns(command, opts.preference, opts);
        return;
      }
      const org = await resolveOrg(command);
      const page = await createClient().get<RunListResponse>(
        `/api/v1/orgs/${encodeURIComponent(org)}/runs`,
        {
          status: opts.status,
          batch: opts.batch,
          prompt: opts.prompt,
          experiment: opts.experiment,
          evalSet: opts.eval,
          since: opts.since,
          limit: opts.limit,
          cursor: opts.cursor,
        },
      );
      if (output === "json") {
        printJson(page);
        return;
      }
      printItems(page.items.map(toRow), "table");
      if (page.nextCursor) {
        console.error(
          `(more results — rerun with --cursor ${page.nextCursor})`,
        );
      }
    });

  run
    .command("get <id>")
    .description(
      "Show a run (status, trigger source, cost, credits, turns, exit reason). --logs prints its trace events instead",
    )
    .option("--logs", "print the trace events so far, then exit")
    .action(async (id: string, opts: { logs?: boolean }, command: Command) => {
      if (gaugeState(command).mode === "local") {
        const dir = localDirectory(command);
        const session = withLocalStore(command, (store) =>
          store.getSession(id),
        );
        if (!session)
          throw new CliError(
            "usage",
            `Local run ${id} was not found. Use gauge run repair --local if its artifacts exist.`,
          );
        if (opts.logs) {
          const path = join(
            dir,
            "runs",
            session.id,
            "attempts",
            String(session.attempt),
            "session",
            "events.ndjson",
          );
          if (!existsSync(path))
            throw new CliError(
              "usage",
              "This run has no transcript artifact yet.",
            );
          process.stdout.write(readFileSync(path, "utf8"));
        } else printJson({ ...session, analysis: getLocalAnalysis(dir, id) });
        return;
      }
      if (opts.logs) {
        await streamRun(id, resolveOutput(command) === "json", {
          idleMs: 2_000,
          firstEventMs: 15_000,
          stopAtLiveMs: Date.now() - 2_000,
        });
        return;
      }
      const run = await createClient().get<RunDetail>(runPath(id));
      if (resolveOutput(command) === "json") {
        printJson(run);
        return;
      }
      const lines = detailLines(run);
      const width = Math.max(...lines.map(([label]) => label.length));
      for (const [label, value] of lines) {
        console.log(`${label.padEnd(width)}  ${value}`);
      }
    });

  run
    .command("insight <id>")
    .description("Show the run's findings, criteria, and product decisions")
    .action(async (id: string, _opts: unknown, command: Command) => {
      if (gaugeState(command).mode === "local") {
        const dir = localDirectory(command);
        if (!withLocalStore(command, (store) => store.getSession(id)))
          throw new CliError("usage", `Local run ${id} was not found.`);
        const analysis = getLocalAnalysis(dir, id);
        if (resolveOutput(command) === "json")
          printJson({ runId: id, analysis });
        else
          console.log(
            analysis
              ? renderLocalAnalysisMarkdown(analysis)
              : "No analysis published. Follow gauge instructions session-analysis --local.",
          );
        return;
      }
      const insight = await createClient().get<RunInsightResponse>(
        `${runPath(id)}/insight`,
      );
      if (resolveOutput(command) === "json") {
        printJson(insight);
        return;
      }
      printInsight(insight);
    });

  const analysis = run
    .command("analysis")
    .description("Publish structured analysis from your coding agent");
  analysis
    .command("schema")
    .description("Print the versioned analysis submission schema")
    .action(() => printJson(z.toJSONSchema(analysisSubmissionSchema)));
  analysis
    .command("save <id>")
    .description("Validate and publish analysis for a local session attempt")
    .requiredOption("--file <path>", "analysis JSON file")
    .action((id: string, opts: { file: string }, command: Command) => {
      if (gaugeState(command).mode !== "local")
        throw new CliError(
          "usage",
          "Analysis submission is available locally; hosted Gauge publishes its own analysis. Use --local.",
        );
      let input: unknown;
      try {
        input = JSON.parse(readFileSync(opts.file, "utf8"));
      } catch (error) {
        throw new CliError(
          "usage",
          `Cannot read analysis JSON: ${String(error)}`,
        );
      }
      const dir = localDirectory(command);
      const saved = saveLocalAnalysis(dir, id, input);
      const results = join(dir, "runs", saved.runId, "results");
      try {
        mkdirSync(results, { recursive: true });
        writeFileSync(
          join(results, "session-analysis.md"),
          renderLocalAnalysisMarkdown(saved),
        );
      } catch (error) {
        console.error(
          `Analysis ${saved.id} was published in SQLite, but its Markdown report could not be written: ${String(error)}. Read it with gauge run insight ${id} --local.`,
        );
      }
      if (resolveOutput(command) === "json") printJson(saved);
      else
        console.log(
          `Published analysis ${saved.id} (revision ${saved.revision}); ${saved.findings.length} findings. Read with gauge run insight ${id} --local.`,
        );
    });
  run
    .command("repair")
    .description(
      "Rebuild local session summaries from artifacts; preserve saved measurements and analysis",
    )
    .action((_opts: unknown, command: Command) => {
      if (gaugeState(command).mode !== "local")
        throw new CliError(
          "usage",
          "Session repair is local only; pass --local.",
        );
      printJson(
        withLocalStore(command, (store) => store.repairSessionSummaries()),
      );
    });

  hostedOnly(run.command("regrade <id>"))
    .description(
      "Re-judge using current eval criteria or the run's criteria snapshot (no new session)",
    )
    .action(async (id: string, _opts: unknown, command: Command) => {
      const result = await createClient().post<RegradeRunResponse>(
        `${runPath(id)}/regrade`,
      );
      if (resolveOutput(command) === "json") {
        printJson(result);
        return;
      }
      console.log(
        `Re-judging run ${result.runId} against ${result.criteria} ${
          result.criteria === 1 ? "criterion" : "criteria"
        } ${result.evalSetId ? `of eval ${result.evalSetId}` : "from its launch-time snapshot"}.`,
      );
      console.log("Verdicts land on the run; `gauge run get <id>` to check.");
    });

  hostedOnly(run.command("watch <id>"))
    .description(
      "Stream normalized trace events live (SSE; exits when the run finishes)",
    )
    .action(async (id: string, _opts: unknown, command: Command) => {
      await streamRun(id, resolveOutput(command) === "json", {
        idleMs: 0,
        firstEventMs: 0,
        pollStatus: true,
      });
    });

  run
    .command("diff <id>")
    .description("Print the run's working-tree diff to stdout")
    .action(async (id: string, _opts: unknown, command: Command) => {
      if (gaugeState(command).mode === "local") {
        const session = withLocalStore(command, (store) =>
          store.getSession(id),
        );
        if (!session)
          throw new CliError("usage", `Local run ${id} was not found.`);
        const path = join(
          localDirectory(command),
          "runs",
          session.id,
          "attempts",
          String(session.attempt),
          "session",
          "diff.patch",
        );
        if (existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
        else console.error("(no diff)");
        return;
      }
      const diff = await createClient().get<string>(`${runPath(id)}/diff`);
      if (!diff) {
        console.error("(no diff)");
        return;
      }
      process.stdout.write(diff);
    });

  run
    .command("status [id]")
    .description(
      "Print a launch request's progress once, without waiting; local: live session status and batch progress",
    )
    .option("--batch <batch-id>", "show this local batch")
    .action(
      async (
        id: string | undefined,
        opts: { batch?: string },
        command: Command,
      ) => {
        const state = gaugeState(command);
        if (state.mode !== "local") {
          if (!id || opts.batch)
            throw new CliError(
              "usage",
              "Hosted status requires a request ID; --batch is local only",
            );
          const result =
            await createClient().get<runRequests.RunRequestResponse>(
              await runRequestPath(command, id),
            );
          if (resolveOutput(command) === "json") printJson(result);
          else printRunRequest(result);
          return;
        }
        if (!state.root)
          throw new CliError(
            "usage",
            "Run this command inside the batch's Gauge workspace",
          );
        if (id && opts.batch)
          throw new CliError("usage", "Pass a run ID or --batch, not both");
        const gaugeDir = join(state.root, ".gauge");
        const runs = await localStatus(gaugeDir, { id, batch: opts.batch });
        let batch;
        if (opts.batch) {
          try {
            batch = await localBatchStatus(gaugeDir, opts.batch);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        if ((id || opts.batch) && !runs.length && !batch)
          throw new CliError("not_found", "Local run or batch not found");
        if (resolveOutput(command) === "json") printJson({ batch, runs });
        else printLocalStatus(batch, runs);
      },
    );

  run
    .command("cancel [id]")
    .option(
      "--batch <batch-id>",
      "cancel an entire local batch, including queued sessions",
    )
    .description("Request cancellation of a run")
    .action(
      async (
        id: string | undefined,
        opts: { batch?: string },
        command: Command,
      ) => {
        const state = gaugeState(command);
        if (state.mode === "local") {
          if (!state.root)
            throw new CliError(
              "usage",
              "Run this command inside the batch's Gauge workspace",
            );
          const results = await cancelLocal(join(state.root, ".gauge"), {
            id,
            batch: opts.batch,
          });
          if (results.some((r) => r.status === "pending")) process.exitCode = 1;
          if (resolveOutput(command) === "json")
            printJson({ cancelRequested: true, runs: results });
          else {
            console.log(`Cancellation requested for ${opts.batch ?? id}.`);
            for (const result of results)
              console.log(
                `${result.id}: ${result.status}${"detail" in result ? ` (${result.detail})` : ""}`,
              );
          }
          return;
        }
        if (!id || opts.batch)
          throw new CliError(
            "usage",
            "Hosted cancellation requires a run ID; --batch is local only",
          );
        const result = await createClient().post<CancelRunResponse>(
          `${runPath(id)}/cancel`,
        );
        if (resolveOutput(command) === "json") {
          printJson(result);
          return;
        }
        console.log(
          `Run ${result.id}: ${result.status}${
            result.cancelRequested ? " (cancel requested)" : ""
          }`,
        );
        if (result.note) console.error(result.note);
      },
    );

  run
    .command("compare")
    .description(
      "Compare two sets of runs: pass rate, criteria, and median turns, cost, and duration, per agent and model. Local: completed runs and median turns",
    )
    .requiredOption(
      "--baseline <key=value>",
      "baseline runs (repeatable): request=, batch=, eval=, revision=, experiment=, trial=, agent=, model=, since=, until= (local: batch=, eval=<saved id>, revision=<number>, agent=, model=, since=, until=)",
      collect,
      [] as string[],
    )
    .requiredOption(
      "--candidate <key=value>",
      "candidate runs (repeatable), same keys as --baseline",
      collect,
      [] as string[],
    )
    .addHelpText(
      "after",
      `
${style("1")(" EXAMPLES")}
   gauge run compare --baseline request=<id> --candidate request=<id>
   gauge run compare --baseline eval=<id> --candidate trial=<trialId>
   gauge run compare --baseline eval=<id> --baseline revision=<hash> \\
                     --candidate eval=<id> --candidate since=2h
   gauge run compare --local --baseline batch=<id> --candidate batch=<id>`,
    )
    .action(
      async (
        opts: { baseline: string[]; candidate: string[] },
        cmd: Command,
      ) => {
        const body = {
          baseline: parseCompareSide("--baseline", opts.baseline),
          candidate: parseCompareSide("--candidate", opts.candidate),
        };
        const state = gaugeState(cmd);
        let result: RunCompareResponse;
        let warnings: (result: RunCompareResponse) => string[];
        if (state.mode === "local") {
          const baseline = localCompareFilter("--baseline", body.baseline);
          const candidate = localCompareFilter("--candidate", body.candidate);
          const root = state.root;
          if (!root)
            throw new CliError(
              "usage",
              "Local runs need a Gauge workspace. Run `gauge init` in this directory first.",
            );
          const gaugeDir = join(root, ".gauge");
          result = compareLocalRuns(
            listLocalRuns(gaugeDir, baseline),
            listLocalRuns(gaugeDir, candidate),
          );
          warnings = localCompareWarnings;
        } else {
          result = await createClient().post<RunCompareResponse>(
            `/api/v1/orgs/${encodeURIComponent(await resolveOrg(cmd))}/runs/compare`,
            body,
          );
          warnings = compareWarnings;
        }
        if (resolveOutput(cmd) === "json") {
          printJson(result);
          return;
        }
        for (const warning of warnings(result))
          console.error(`Warning: ${warning}`);
        printComparison(result);
      },
    );

  run
    .command("wait [request-id]")
    .description(
      "Wait for every session and judge in a launch request, then print the verdict. Exits 0 once settled, whatever the verdict. Local: wait for a batch with --batch",
    )
    .option("--batch <batch-id>", "wait for this local batch")
    .option(
      "--check",
      "exit 1 unless the verdict is PASSED or MEASURED (for CI gates); local: unless every session completed",
    )
    .action(
      async (
        id: string | undefined,
        opts: { batch?: string; check?: boolean },
        cmd: Command,
      ) => {
        const state = gaugeState(cmd);
        if (state.mode === "local") {
          if (!opts.batch || id)
            throw new CliError(
              "usage",
              "Local wait takes --batch <batch-id>, not a request ID",
            );
          if (!state.root)
            throw new CliError(
              "usage",
              "Run this command inside the batch's Gauge workspace",
            );
          return waitForLocalBatch(
            cmd,
            join(state.root, ".gauge"),
            opts.batch,
            opts,
          );
        }
        if (!id || opts.batch)
          throw new CliError(
            "usage",
            "Hosted wait requires a request ID; --batch is local only",
          );
        return waitForRequest(cmd, id, opts);
      },
    );
}
