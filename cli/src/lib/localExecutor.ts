import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  writeFile,
  open,
  readFile,
  rename,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  RunDefinitionCase,
  RunDefinitionSubmission,
} from "@withgauge/api-schemas/runDefinitions";
import type { RunPlanResource } from "@withgauge/api-schemas/runPlan";
import {
  CredentialError,
  finishSession,
  getSessionStatus,
  type ResourceRef,
  type SessionSpec,
  type SessionStatus,
  startSession,
  stopSession,
} from "@withgauge/local-execution";
import { CliError } from "./client";
import { assertLocalCapabilities } from "./localCapabilities";
import { batchDirectory, cancellationRequested } from "./localLifecycle";
import { fileURLToPath } from "node:url";
import {
  credentialKey,
  inspectLocalCredential,
  LOCAL_TARGETS,
  profileCredentialSources,
  readProfiles,
  resolveLocalProfile,
  type CredentialReadiness,
  type LocalCredentialOptions,
  type ResolvedLocalProfile,
} from "./localProfiles";

import {
  RUNTIME_IMAGE,
  inspectLocalRuntime,
  requireLocalRuntime,
  type RuntimeInspection,
} from "./localRuntime";
import { checkLocalRuntimeCompatibility } from "./localRuntimeCompatibility";
import {
  openLocalStore,
  type LocalSessionSummary,
  type MeasurementKind,
} from "./localStore";
export { RUNTIME_IMAGE } from "./localRuntime";

type ResolvedLocalRuntime = RuntimeInspection & { imageId: string };
export type LocalRuntimeOptions = { runtimeImage?: string };

const CONCURRENCY = 4;
const POLL_MS = 1_000;

export const LOCAL_AGENTS: Record<
  string,
  { kind: SessionSpec["agent"]["kind"]; model: string }
> = LOCAL_TARGETS;

type Upload = { path: string; sha256: string };

export type LocalRunSummary = {
  id: string;
  case: string;
  agent: string;
  model: string;
  sample: number;
  outcome: string;
  endedBy: string;
  turns: number;
  detail?: string;
};

export type LocalBatch = {
  batchId: string;
  runs: LocalRunSummary[];
  next: string;
  canceled?: boolean;
};

type Job = {
  item: RunDefinitionCase;
  agent: string;
  model: string;
  sample: number;
};

export function analysisNext(batchId: string): string {
  return [
    "Next: analyze these runs. Run this command and follow it:",
    "  gauge instructions session-analysis --local",
    `Analyze only batch ${batchId}.`,
  ].join("\n");
}

export type LocalPlan = {
  mode: "local";
  runtime: RuntimeInspection;
  runtimeProbe: "not_run";
  expectedSessions: number;
  cases: {
    path: string;
    criteria: number;
    sessions: { agent: string; model: string; samples: number }[];
  }[];
  inputs: { name: string; use: string }[];
  warnings: string[];
  credentials: CredentialReadiness[];
};

export async function planLocal(
  definition: RunDefinitionSubmission,
  options: LocalCredentialOptions & LocalRuntimeOptions = {},
): Promise<LocalPlan> {
  const { resources, queue } = plan(definition);
  const warnings: string[] = [];
  const runtime = inspectLocalRuntime(options.runtimeImage);
  if (runtime.problem)
    warnings.push(`${runtime.problem.message} ${runtime.problem.hint}`);
  const credentials = await credentialReadiness(queue, options);
  for (const target of credentials)
    if (!target.ready)
      warnings.push(`${target.agent} ${target.model}: ${target.problem}`);
  return {
    mode: "local",
    runtime,
    runtimeProbe: "not_run",
    expectedSessions: queue.length,
    cases: definition.cases.map((item) => {
      const sessions = new Map<
        string,
        LocalPlan["cases"][number]["sessions"][number]
      >();
      for (const job of queue.filter((job) => job.item === item)) {
        const key = `${job.agent}\0${job.model}`;
        const entry = sessions.get(key) ?? {
          agent: job.agent,
          model: job.model,
          samples: 0,
        };
        entry.samples++;
        sessions.set(key, entry);
      }
      return {
        path: item.path,
        criteria: item.criteria?.length ?? 0,
        sessions: [...sessions.values()],
      };
    }),
    inputs: [...resources.values()].map((r) => ({
      name: r.name,
      use: r.use?.type ?? r.kind,
    })),
    warnings,
    credentials,
  };
}

function plan(definition: RunDefinitionSubmission) {
  for (const item of definition.cases) {
    assertLocalCapabilities(item.config, `${item.path}: config.`);
    if (item.config.repoRef && !item.config.repoUrl)
      throw new CliError(
        "usage",
        `${item.path}: config.repoRef requires config.repoUrl.`,
      );
    for (const name of item.config.inputs ?? [])
      if (!definition.resources.some((resource) => resource.name === name))
        throw new CliError(
          "usage",
          `${item.path}: input ${name} is missing from this launch.`,
        );
  }
  const resources = new Map(
    definition.resources.map((resource) => [
      resource.name,
      toResourceRef(resource),
    ]),
  );
  const queue = definition.cases.flatMap((item) =>
    item.config.agents.flatMap((entry) => {
      const agent = LOCAL_AGENTS[entry.agent];
      if (!agent)
        throw new CliError(
          "usage",
          `${item.path}: agent ${entry.agent} cannot run locally.`,
          {
            hint: "Use CLAUDE_CODE, CODEX_CLI, PI, or OPENCODE, or pass --hosted.",
          },
        );
      const models = entry.models?.length ? entry.models : [agent.model];
      return models.flatMap((model) =>
        Array.from(
          { length: item.config.sampleCount ?? 1 },
          (_, sample): Job => ({
            item,
            agent: entry.agent,
            model,
            sample: sample + 1,
          }),
        ),
      );
    }),
  );
  return { resources, queue };
}

export type BatchOptions = LocalCredentialOptions &
  LocalRuntimeOptions & {
    batchId?: string;
    measurement?: {
      id: string;
      kind: MeasurementKind;
      revision: number;
      criterionIds?: string[];
    };
    onStart?: (batchId: string) => void;
  };

export async function prepareLocal(
  definition: RunDefinitionSubmission,
  uploads: Upload[],
  gaugeDir: string,
  options: BatchOptions = {},
) {
  const { queue } = plan(definition);
  await freezeCredentials(queue, options);
  const runtime = requireLocalRuntime(options.runtimeImage);
  await checkLocalRuntimeCompatibility(runtime.imageId, [
    ...new Set(queue.map((job) => LOCAL_AGENTS[job.agent].kind)),
  ]);
  const blobsDirectory = join(gaugeDir, "blobs");
  await mkdir(blobsDirectory, { recursive: true });
  for (const upload of uploads)
    await copyFile(upload.path, join(blobsDirectory, upload.sha256.slice(7)));
  const batchId = `b_${randomBytes(6).toString("hex")}`;
  const directory = batchDirectory(gaugeDir, batchId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeJson(join(directory, "runtime.json"), runtime);
  await writeJson(join(directory, "status.json"), {
    batchId,
    runtime,
    state: "queued",
    expectedSessions: plan(definition).queue.length,
  });
  const store = openLocalStore(gaugeDir);
  try {
    store.recordLaunch({
      id: batchId,
      measurementId: options.measurement?.id,
      measurementRevision: options.measurement?.revision,
      configuration: definition,
      provenance: definition.source ?? {},
    });
  } finally {
    store.close();
  }
  return batchId;
}

export async function detachLocal(
  definition: RunDefinitionSubmission,
  uploads: Upload[],
  gaugeDir: string,
  options: BatchOptions = {},
) {
  const credentialSelections = await freezeCredentials(
    plan(definition).queue,
    options,
  );
  const batchId = await prepareLocal(definition, uploads, gaugeDir, {
    ...options,
    credentialSelections,
  });
  const directory = batchDirectory(gaugeDir, batchId);
  await writeFile(
    join(directory, "request.json"),
    JSON.stringify({
      definition,
      gaugeDir,
      batchId,
      credentialSelections,
      measurement: options.measurement,
    }),
    { mode: 0o600 },
  );
  const log = await open(join(directory, "supervisor.log"), "a", 0o600);
  try {
    const bundledWorker = fileURLToPath(
      new URL("./batchWorker.js", import.meta.url),
    );
    const workerArgs = existsSync(bundledWorker)
      ? [bundledWorker]
      : [
          ...process.execArgv,
          fileURLToPath(new URL("../batchWorker.ts", import.meta.url)),
        ];
    const child = spawn(
      process.execPath,
      [...workerArgs, join(directory, "request.json")],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const deadline = Date.now() + 10_000;
    while (true) {
      const status = JSON.parse(
        await readFile(join(directory, "status.json"), "utf8"),
      );
      if (status.state !== "queued") break;
      if (exited || Date.now() >= deadline) {
        await writeFile(join(directory, "cancel"), "", { mode: 0o600 });
        throw new CliError(
          "network",
          `Background supervisor did not become ready. See ${join(directory, "supervisor.log")}`,
        );
      }
      await delay(50);
    }
    child.unref();
  } finally {
    await log.close();
  }
  return {
    batchId,
    status: `gauge run status --batch ${batchId} --local`,
    wait: `gauge run wait --batch ${batchId} --local`,
    stop: `gauge run cancel --batch ${batchId} --local`,
  };
}

export async function runLocal(
  definition: RunDefinitionSubmission,
  uploads: Upload[],
  gaugeDir: string,
  onRun: (run: LocalRunSummary) => void = () => {},
  options: BatchOptions = {},
): Promise<LocalBatch> {
  const { resources, queue } = plan(definition);
  const credentialSelections = await freezeCredentials(queue, options);
  const batchId =
    options.batchId ??
    (await prepareLocal(definition, uploads, gaugeDir, {
      ...options,
      credentialSelections,
    }));
  const directory = batchDirectory(gaugeDir, batchId);
  const runtime: ResolvedLocalRuntime = JSON.parse(
    await readFile(join(directory, "runtime.json"), "utf8"),
  );
  const expectedSessions = queue.length;
  let interrupted = false;
  const signal = () => {
    interrupted = true;
    process.exitCode = 130;
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  const canceled = () => interrupted || cancellationRequested(directory);
  const runs: LocalRunSummary[] = [];
  let progress = Promise.resolve();
  const save = (state: string) =>
    writeJson(join(directory, "status.json"), {
      batchId,
      runtime,
      state,
      expectedSessions,
      finishedSessions: runs.length,
      queuedSessions: state === "running" ? queue.length : 0,
      skippedSessions: state === "running" ? 0 : queue.length,
      supervisorPid: process.pid,
    });
  try {
    await save("running");
    options.onStart?.(batchId);
    const worker = async () => {
      while (!canceled()) {
        const job = queue.shift();
        if (!job) break;
        const run = await runJob(job, {
          batchId,
          gaugeDir,
          blobsDirectory: join(gaugeDir, "blobs"),
          resources,
          credentialSelections,
          runtime,
          canceled,
          measurement: options.measurement,
          provenance: definition.source ?? {},
        });
        runs.push(run);
        onRun(run);
        progress = progress.then(() => save("running"));
        await progress;
      }
    };
    const settled = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, worker),
    );
    const failure = settled.find((s) => s.status === "rejected");
    await save(failure ? "failed" : canceled() ? "canceled" : "completed");
    if (failure?.status === "rejected") throw failure.reason;
    return { batchId, runs, next: analysisNext(batchId), canceled: canceled() };
  } finally {
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  }
}

function toResourceRef(resource: RunPlanResource): ResourceRef {
  if (resource.source.type !== "upload")
    throw new CliError(
      "usage",
      `Input ${resource.name} has no local file; local runs need every input in the working tree`,
    );
  const base = {
    name: resource.name,
    digest: resource.source.sha256,
    filename: `${resource.name}.tar.gz`,
    kind: "archive" as const,
  };
  const use = resource.use;
  if (use.type === "files") return { ...base, use: { type: "files" } };
  if (use.type === "skill" && use.root === ".")
    return { ...base, use: { type: "skill" } };
  if (use.type === "npm-package")
    return {
      ...base,
      use: {
        type: "npm-package",
        package: use.package,
        install: use.install ?? "workspace",
      },
    };
  throw new CliError(
    "usage",
    `Input ${resource.name}: ${use.type === "skill" ? "supply the Skill as a directory" : `${use.type} inputs run on hosted Gauge only`}`,
  );
}

async function credentialReadiness(
  queue: Job[],
  options: LocalCredentialOptions,
): Promise<CredentialReadiness[]> {
  const store = options.credentialSelections
    ? { version: 1 as const, profiles: {}, defaults: {} }
    : readProfiles();
  const targets = new Map(
    queue.map((job) => [credentialKey(job.agent, job.model), job]),
  );
  return Promise.all(
    [...targets.values()].map((job) =>
      inspectLocalCredential(job.agent, job.model, options, store),
    ),
  );
}

async function freezeCredentials(
  queue: Job[],
  options: LocalCredentialOptions,
): Promise<Record<string, ResolvedLocalProfile>> {
  const readiness = await credentialReadiness(queue, options);
  const failures = readiness.filter((target) => !target.ready);
  if (failures.length)
    throw new CliError(
      "usage",
      failures
        .map((target) => `${target.agent} ${target.model}: ${target.problem}`)
        .join("\n"),
      {
        hint: "Inspect credentials with gauge local profiles inspect <profile>, or preview every target with gauge run --local --dry-run -o json.",
      },
    );
  return Object.fromEntries(
    readiness.map((target) => [
      credentialKey(target.agent, target.model),
      target.profile!,
    ]),
  );
}

function sessionSpec(
  job: Job,
  resources: Map<string, ResourceRef>,
  profile: ResolvedLocalProfile,
  runtimeImage: string = RUNTIME_IMAGE,
): SessionSpec {
  const names = job.item.config.inputs ?? [...resources.keys()];
  const selected = names.flatMap((name) => resources.get(name) ?? []);
  const files = selected.filter((r) => r.use?.type === "files");
  const note = files.length
    ? `\n\nPrepared inputs:\n${files.map((r) => `- ${r.name}: /gauge/session/resources/${r.name}/content`).join("\n")}`
    : "";
  const { repoUrl, repoRef } = job.item.config;
  const agent = LOCAL_AGENTS[job.agent];
  return {
    image: runtimeImage,
    agent: { kind: agent.kind, model: job.model },
    auth: { mode: profile.auth },
    workspace: repoUrl ? { repo: repoUrl, ref: repoRef ?? "HEAD" } : null,
    resources: selected,
    prompt: { text: job.item.prompt + note },
    limits: { turnTimeoutS: 1800, responseTimeoutS: 60, maxTurns: 1 },
  };
}

async function runJob(
  job: Job,
  context: {
    batchId: string;
    gaugeDir: string;
    blobsDirectory: string;
    resources: Map<string, ResourceRef>;
    credentialSelections: Record<string, ResolvedLocalProfile>;
    runtime: ResolvedLocalRuntime;
    canceled: () => boolean;
    measurement: BatchOptions["measurement"];
    provenance: Record<string, unknown>;
  },
): Promise<LocalRunSummary> {
  const id = `r_${randomBytes(6).toString("hex")}`;
  const attemptDir = join(context.gaugeDir, "runs", id, "attempts", "1");
  const directory = join(attemptDir, "session");
  await mkdir(attemptDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const frozenCase = {
    ...job.item,
    criteria:
      job.item.criteria?.map((criterion, index) => ({
        ...criterion,
        id:
          context.measurement?.criterionIds?.[index] ??
          `criterion-${index + 1}`,
      })) ?? null,
    preference: job.item.preference ?? null,
  };
  const configuration = { ...job.item.config, case: frozenCase };
  const metadata = {
    attempt: { runId: id, n: 1, batchId: context.batchId },
    createdAt,
    launchId: context.batchId,
    measurement: context.measurement ?? null,
    provenance: context.provenance,
    configuration,
    agent: { kind: LOCAL_AGENTS[job.agent].kind, model: job.model },
    agentName: job.agent,
    runtime: context.runtime,
    case: frozenCase,
    sample: job.sample,
  };
  await writeJson(join(attemptDir, "spec.json"), metadata);
  const session: LocalSessionSummary = {
    id,
    batchId: context.batchId,
    launchId: context.batchId,
    measurementId: context.measurement?.id ?? null,
    measurementKind: context.measurement?.kind ?? null,
    measurementRevision: context.measurement?.revision ?? null,
    case: job.item.path,
    agent: job.agent,
    model: job.model,
    attempt: 1,
    outcome: "starting",
    endedBy: null,
    turns: null,
    createdAt,
    endedAt: null,
    configuration,
    provenance: context.provenance,
  };
  persistSession(context.gaugeDir, session);
  const summary = (
    status: Pick<SessionStatus, "state" | "turn" | "detail">,
    endedBy: string,
  ): LocalRunSummary => ({
    id,
    case: job.item.path,
    agent: job.agent,
    model: job.model,
    sample: job.sample,
    outcome: status.state,
    endedBy,
    turns: status.turn,
    ...(status.detail ? { detail: status.detail } : {}),
  });
  const canceled = () =>
    context.canceled() || cancellationRequested(attemptDir);
  let result: LocalRunSummary;
  try {
    const profile = resolveLocalProfile(job.agent, job.model, {
      credentialSelections: context.credentialSelections,
    });
    const spec = sessionSpec(
      job,
      context.resources,
      profile,
      context.runtime.imageId,
    );
    await writeJson(join(attemptDir, "spec.json"), {
      ...metadata,
      session: spec,
      credentialProfile: profile,
    });
    if (canceled()) {
      result = summary({ state: "canceled", turn: 0 }, "user_cancel");
    } else {
      await startSession({
        directory,
        spec,
        blobsDirectory: context.blobsDirectory,
        credentials: profileCredentialSources(profile),
      });
      result = await drive(directory, summary, canceled);
    }
  } catch (error) {
    let cleanupError: unknown;
    try {
      await stopSession(directory);
    } catch (failure) {
      cleanupError = failure;
    }
    result = summary(
      {
        state: "failed",
        turn: 0,
        detail:
          error instanceof CredentialError
            ? `${error.message} Fix: ${error.remedy}`
            : error instanceof Error
              ? error.message
              : String(error),
      },
      "error",
    );
    if (cleanupError && existsSync(join(directory, "session.json")))
      result.detail += `; cleanup pending: ${String(cleanupError)}. Run gauge cleanup --local.`;
  }
  const { outcome, endedBy, turns, detail } = result;
  const endedAt = new Date().toISOString();
  const durationMs = Date.parse(endedAt) - Date.parse(createdAt);
  await writeJson(join(attemptDir, "result.json"), {
    outcome,
    endedBy,
    turns,
    endedAt,
    durationMs,
    ...(detail ? { detail } : {}),
  });
  persistSession(context.gaugeDir, {
    ...session,
    outcome,
    endedBy,
    turns,
    endedAt,
    durationMs,
  });
  return result;
}

function persistSession(gaugeDir: string, session: LocalSessionSummary): void {
  const store = openLocalStore(gaugeDir);
  try {
    store.upsertSession(session);
  } finally {
    store.close();
  }
}

async function drive(
  directory: string,
  summary: (status: SessionStatus, endedBy: string) => LocalRunSummary,
  canceled: () => boolean,
): Promise<LocalRunSummary> {
  let endedBy = "session";
  for (;;) {
    if (canceled() && endedBy !== "user_cancel") {
      endedBy = "user_cancel";
      await stopSession(directory);
    }
    const status = await getSessionStatus(directory);
    if (status.state === "waiting" && endedBy === "session") {
      endedBy = "supervisor_finish";
      await finishSession(directory, status.turn);
    } else if (status.state === "blocked" && endedBy === "session") {
      endedBy = "supervisor_stop";
      await stopSession(directory);
    } else if (
      ["completed", "failed", "canceled", "interrupted"].includes(status.state)
    ) {
      if (status.cleanupPending || status.state === "interrupted")
        await stopSession(directory);
      return summary(await getSessionStatus(directory), endedBy);
    }
    await delay(POLL_MS);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
}
