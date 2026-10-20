import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  analysisSubmissionSchema,
  ANALYSIS_SCHEMA_VERSION,
  type AnalysisSubmission,
  type PortableEvidenceRef,
} from "@withgauge/api-schemas/sessionAnalysis";
import { CliError } from "./client";
import {
  openLocalStore,
  type LocalStore,
  type StoredLocalSession,
} from "./localStore";

export type PublishedLocalAnalysis = AnalysisSubmission & {
  id: string;
  runId: string;
  revision: number;
  createdAt: string;
  evidenceDigest: string;
  findings: (AnalysisSubmission["findings"][number] & { id: string })[];
};

export function saveLocalAnalysis(
  gaugeDir: string,
  runId: string,
  value: unknown,
): PublishedLocalAnalysis {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion !== ANALYSIS_SCHEMA_VERSION
  ) {
    throw new CliError(
      "usage",
      `Analysis schema version ${String(value.schemaVersion)} is not supported. This CLI accepts version ${ANALYSIS_SCHEMA_VERSION}; upgrade Gauge for newer analyses. No data was changed.`,
    );
  }
  const parsed = analysisSubmissionSchema.safeParse(value);
  if (!parsed.success)
    throw new CliError(
      "usage",
      `Invalid analysis: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "analysis"}: ${issue.message}`).join("; ")}`,
      {
        hint: "Use gauge run analysis schema for the analysis submission contract.",
      },
    );
  const submission = parsed.data;
  const store = openLocalStore(gaugeDir);
  try {
    const session = store.getSession(runId);
    if (!session)
      throw new CliError("usage", `Local run ${runId} was not found.`, {
        hint: "Use gauge run list --local, or repair session summaries if its artifacts exist.",
      });
    if (
      !["completed", "failed", "canceled", "interrupted"].includes(
        session.outcome,
      )
    )
      throw new CliError(
        "usage",
        `Run ${runId} is ${session.outcome}. Wait until it finishes before publishing analysis.`,
      );
    if (session.attempt !== submission.attempt)
      throw new CliError(
        "usage",
        `Run ${runId} is on attempt ${session.attempt}; the submitted analysis targets attempt ${submission.attempt}.`,
      );
    validateCriteria(session, submission);
    const attemptDirectory = safeAttemptDirectory(
      gaugeDir,
      runId,
      submission.attempt,
    );
    const files = new Map<string, string>();
    const refs = [
      ...submission.findings.flatMap((finding) => finding.evidence),
      ...submission.products.flatMap((product) =>
        Object.values(product.evidence).flat(),
      ),
      ...submission.criteria.flatMap((criterion) => criterion.evidence),
    ];
    for (const ref of refs)
      validateEvidence(attemptDirectory, submission.attempt, ref, files);
    const hash = createHash("sha256");
    for (const [path, contents] of [...files].sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      hash.update(path).update("\0").update(contents).update("\0");
    const evidenceDigest = `sha256:${hash.digest("hex")}`;
    return store.transaction(() => {
      const currentSession = store.getSession(runId)!;
      if (currentSession.attempt !== submission.attempt)
        throw new CliError(
          "usage",
          "The run advanced to another attempt while validating analysis. Read its new evidence before publishing.",
        );
      const latest = store.db
        .prepare(
          "SELECT MAX(revision) AS revision FROM session_analyses WHERE run_id = ?",
        )
        .get(runId);
      const analysis: PublishedLocalAnalysis = {
        ...submission,
        id: `a_${randomUUID()}`,
        runId,
        revision: Number(latest?.revision ?? 0) + 1,
        createdAt: new Date().toISOString(),
        evidenceDigest,
        findings: submission.findings.map((finding) => ({
          ...finding,
          id: `f_${randomUUID()}`,
        })),
      };
      store.db
        .prepare("INSERT INTO session_analyses VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          analysis.id,
          runId,
          analysis.attempt,
          analysis.revision,
          analysis.schemaVersion,
          analysis.instructionsVersion,
          evidenceDigest,
          JSON.stringify(analysis),
          analysis.createdAt,
        );
      const findingStatement = store.db.prepare(
        "INSERT INTO session_findings VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      );
      for (const finding of analysis.findings)
        findingStatement.run(
          finding.id,
          analysis.id,
          finding.kind,
          finding.subject,
          finding.label,
          finding.detail,
          finding.basis,
          finding.effect,
          finding.cause,
          JSON.stringify(finding.tags),
          JSON.stringify(finding.evidence),
        );
      const productStatement = store.db.prepare(
        "INSERT INTO session_products VALUES (?,?,?,?)",
      );
      analysis.products.forEach((product, position) =>
        productStatement.run(
          analysis.id,
          position,
          product.name,
          JSON.stringify(product),
        ),
      );
      const criterionStatement = store.db.prepare(
        "INSERT INTO criterion_results VALUES (?,?,?,?,?)",
      );
      for (const criterion of analysis.criteria)
        criterionStatement.run(
          analysis.id,
          criterion.criterionId,
          criterion.outcome,
          criterion.label,
          JSON.stringify(criterion.evidence),
        );
      store.db
        .prepare("UPDATE sessions SET current_analysis_id = ? WHERE id = ?")
        .run(analysis.id, runId);
      return analysis;
    });
  } finally {
    store.close();
  }
}

export function getLocalAnalysis(
  gaugeDir: string,
  runId: string,
): PublishedLocalAnalysis | null {
  const store = openLocalStore(gaugeDir);
  try {
    return readCurrentAnalysis(store, runId);
  } finally {
    store.close();
  }
}

export function readCurrentAnalysis(
  store: LocalStore,
  runId: string,
): PublishedLocalAnalysis | null {
  const row = store.db
    .prepare(
      "SELECT a.schema_version,a.payload FROM session_analyses a JOIN sessions s ON s.current_analysis_id = a.id WHERE s.id = ?",
    )
    .get(runId);
  if (!row) return null;
  if (row.schema_version !== ANALYSIS_SCHEMA_VERSION)
    throw new CliError(
      "usage",
      `Stored analysis uses schema version ${row.schema_version}; upgrade Gauge to read it. Your data is intact.`,
    );
  return JSON.parse(String(row.payload)) as PublishedLocalAnalysis;
}

function validateCriteria(
  session: StoredLocalSession,
  submission: AnalysisSubmission,
): void {
  const configuration = session.configuration ?? {};
  const item = configuration.case as
    | { criteria?: { id?: string; name?: string }[] | null }
    | undefined;
  const criteria = item?.criteria ?? configuration.criteria ?? [];
  if (!Array.isArray(criteria))
    throw new CliError(
      "usage",
      "This run's frozen criteria are invalid; repair its session summary before analysis.",
    );
  const expected = criteria.map((criterion) => {
    if (!criterion || typeof criterion.id !== "string" || !criterion.id)
      throw new CliError(
        "usage",
        "This run has a frozen criterion without an ID. Criterion IDs must be assigned before execution.",
      );
    return criterion.id;
  });
  const supplied = new Set(
    submission.criteria.map((criterion) => criterion.criterionId),
  );
  const missing = expected.filter((id) => !supplied.has(id));
  const extra = [...supplied].filter((id) => !expected.includes(id));
  if (missing.length || extra.length)
    throw new CliError(
      "usage",
      `Analysis must cover exactly the run's frozen criteria.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${extra.length ? ` Unknown: ${extra.join(", ")}.` : ""} Use UNASSESSABLE with an explanation when evidence is insufficient.`,
    );
}

function safeAttemptDirectory(
  gaugeDir: string,
  runId: string,
  attempt: number,
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(runId))
    throw new CliError("usage", "Invalid local run ID.");
  const directory = join(gaugeDir, "runs", runId, "attempts", String(attempt));
  if (!existsSync(directory))
    throw new CliError("usage", `Run evidence is missing: ${directory}`);
  return realpathSync(directory);
}

function readEvidence(
  directory: string,
  path: string,
  files: Map<string, string>,
): string {
  const fullPath = resolve(directory, path);
  if (!isInside(directory, fullPath))
    throw new CliError(
      "usage",
      `Evidence path ${path} leaves the run's attempt directory.`,
    );
  if (!existsSync(fullPath) || !statSync(fullPath).isFile())
    throw new CliError(
      "usage",
      `Evidence artifact ${path} does not exist in this attempt.`,
    );
  if (!isInside(directory, realpathSync(fullPath)))
    throw new CliError(
      "usage",
      `Evidence artifact ${path} resolves outside this attempt.`,
    );
  const contents = files.get(path) ?? readFileSync(fullPath, "utf8");
  files.set(path, contents);
  return contents;
}

function isInside(directory: string, path: string): boolean {
  const rel = relative(directory, path);
  return (
    rel !== ".." &&
    !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(rel)
  );
}

function validateEvidence(
  directory: string,
  attempt: number,
  ref: PortableEvidenceRef,
  files: Map<string, string>,
): void {
  if (ref.kind === "diff") {
    const diff = readEvidence(directory, "session/diff.patch", files);
    const paths = new Set(
      diff.split("\n").flatMap((line) => {
        const match = /^(?:\+\+\+|---) [ab]\/(.*)$/.exec(line);
        return match ? [match[1].split("\t")[0]] : [];
      }),
    );
    if (!paths.has(ref.path))
      throw new CliError(
        "usage",
        `Diff evidence path ${ref.path} does not appear in this attempt's diff.patch.`,
      );
    return;
  }
  if (
    ref.kind === "artifact" &&
    ref.attempt !== undefined &&
    ref.attempt !== attempt
  )
    throw new CliError(
      "usage",
      `Evidence references attempt ${ref.attempt}, but this analysis targets attempt ${attempt}.`,
    );
  const artifact =
    ref.kind === "trace" ? "session/events.ndjson" : ref.artifact;
  const contents = readEvidence(directory, artifact, files);
  const lines = contents.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (
    ref.kind === "artifact" &&
    ref.line !== undefined &&
    (ref.line > lines.length || (ref.endLine ?? ref.line) > lines.length)
  )
    throw new CliError(
      "usage",
      `Evidence ${artifact}:${ref.line}${ref.endLine ? `-${ref.endLine}` : ""} exceeds the artifact's ${lines.length} lines.`,
    );
  if (ref.seq !== undefined) {
    const hasSequence = lines.some((line) => {
      try {
        return JSON.parse(line).seq === ref.seq;
      } catch {
        return false;
      }
    });
    if (!hasSequence)
      throw new CliError(
        "usage",
        `Evidence sequence ${ref.seq} does not exist in ${artifact}. Copy an event's recorded seq; do not use its array index or turn.`,
        {
          hint: `For evidence without seq, cite an original artifact line, for example ${JSON.stringify({ kind: "artifact", artifact, attempt, line: 1 })}. Line numbers start at 1; choose the line containing your evidence.`,
        },
      );
  }
}

export function renderLocalAnalysisMarkdown(
  analysis: PublishedLocalAnalysis,
): string {
  const lines = [
    `# Session analysis: ${analysis.runId}`,
    "",
    `Analysis ${analysis.id}, revision ${analysis.revision}; attempt ${analysis.attempt}.`,
    `Assessment: ${analysis.assessability}.`,
    "",
  ];
  if (analysis.limitation) lines.push(`Limitation: ${analysis.limitation}`, "");
  for (const finding of analysis.findings)
    lines.push(
      `## ${finding.kind}: ${finding.label}`,
      "",
      `${finding.subject} · ${finding.effect} · ${finding.basis}`,
      "",
      finding.detail,
      "",
      `Evidence: ${finding.evidence.map(formatEvidence).join(", ")}`,
      "",
    );
  if (!analysis.findings.length)
    lines.push("No findings were reported in this analysis.", "");
  if (analysis.criteria.length) {
    lines.push("## Criteria", "");
    for (const criterion of analysis.criteria)
      lines.push(
        `- ${criterion.criterionId}: ${criterion.outcome} — ${criterion.label}`,
      );
    lines.push("");
  }
  if (analysis.products.length) {
    lines.push("## Products", "");
    for (const product of analysis.products)
      lines.push(
        `- ${product.name}: ${product.chosen ? "chosen" : product.rejected ? "rejected" : product.considered ? "considered" : "mentioned"} — ${product.reason}`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

export function formatEvidence(ref: PortableEvidenceRef): string {
  if (ref.kind === "trace") return `trace ${ref.seq}`;
  if (ref.kind === "diff") return `diff ${ref.path}`;
  return `${ref.artifact}${ref.line !== undefined ? `:${ref.line}${ref.endLine !== undefined ? `-${ref.endLine}` : ""}` : ` seq ${ref.seq}`}`;
}
