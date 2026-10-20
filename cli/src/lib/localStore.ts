import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CliError } from "./client";

export const LOCAL_DATABASE_VERSION = 1;
export type MeasurementKind = "eval" | "preference";
export type MeasurementDefinition = {
  name: string;
  promptText: string;
  tags?: string[];
  [key: string]: unknown;
};
export type LocalMeasurement = MeasurementDefinition & {
  id: string;
  measurementKind: MeasurementKind;
  revision: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
};
export type LocalLaunch = {
  id: string;
  measurementId: string | null;
  measurementRevision: number | null;
  configuration: Record<string, unknown>;
  provenance: Record<string, unknown>;
  createdAt: string;
};
export type LocalSessionSummary = {
  id: string;
  batchId: string;
  launchId?: string | null;
  measurementId?: string | null;
  measurementKind?: MeasurementKind | null;
  measurementRevision?: number | null;
  case: string | null;
  agent: string;
  model: string;
  attempt: number;
  outcome: string;
  endedBy: string | null;
  turns: number | null;
  createdAt: string;
  endedAt: string | null;
  durationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  configuration?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};
export type StoredLocalSession = LocalSessionSummary & {
  currentAnalysisId: string | null;
  analyzed: boolean;
};

const schema = `
CREATE TABLE measurements (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('eval','preference')),
  revision INTEGER NOT NULL, definition TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE measurement_revisions (
  measurement_id TEXT NOT NULL REFERENCES measurements(id), revision INTEGER NOT NULL,
  definition TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(measurement_id,revision)
);
CREATE TABLE launches (
  id TEXT PRIMARY KEY, measurement_id TEXT, measurement_revision INTEGER,
  configuration TEXT NOT NULL, provenance TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, launch_id TEXT,
  measurement_id TEXT, measurement_kind TEXT, measurement_revision INTEGER,
  case_path TEXT, agent TEXT NOT NULL, model TEXT NOT NULL, attempt INTEGER NOT NULL,
  outcome TEXT NOT NULL, ended_by TEXT, turns INTEGER, created_at TEXT NOT NULL,
  ended_at TEXT, duration_ms REAL, input_tokens INTEGER, output_tokens INTEGER,
  configuration TEXT NOT NULL, provenance TEXT NOT NULL, current_analysis_id TEXT
);
CREATE INDEX sessions_measurement ON sessions(measurement_id,created_at);
CREATE INDEX sessions_batch ON sessions(batch_id);
CREATE TABLE session_analyses (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES sessions(id), attempt INTEGER NOT NULL,
  revision INTEGER NOT NULL, schema_version INTEGER NOT NULL, instructions_version TEXT NOT NULL,
  evidence_digest TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(run_id,revision)
);
CREATE TABLE session_findings (
  id TEXT PRIMARY KEY, analysis_id TEXT NOT NULL REFERENCES session_analyses(id),
  kind TEXT NOT NULL, subject TEXT NOT NULL, label TEXT NOT NULL, detail TEXT NOT NULL,
  basis TEXT NOT NULL, effect TEXT NOT NULL, cause TEXT NOT NULL, tags TEXT NOT NULL, evidence TEXT NOT NULL
);
CREATE INDEX findings_analysis ON session_findings(analysis_id);
CREATE TABLE session_products (
  analysis_id TEXT NOT NULL REFERENCES session_analyses(id), position INTEGER NOT NULL,
  name TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(analysis_id,position)
);
CREATE TABLE criterion_results (
  analysis_id TEXT NOT NULL REFERENCES session_analyses(id), criterion_id TEXT NOT NULL,
  outcome TEXT NOT NULL, label TEXT NOT NULL, evidence TEXT NOT NULL,
  PRIMARY KEY(analysis_id,criterion_id)
);
PRAGMA user_version = 1;
`;

type Row = Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const parse = (value: unknown) => JSON.parse(String(value));

export class LocalStore {
  constructor(
    readonly gaugeDir: string,
    readonly db: DatabaseSync,
  ) {}

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  createMeasurement(
    kind: MeasurementKind,
    definition: MeasurementDefinition,
  ): LocalMeasurement {
    const normalized = normalizeDefinition(definition);
    const id = `${kind === "eval" ? "ev" : "pr"}_${randomUUID()}`;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db
        .prepare("INSERT INTO measurements VALUES (?,?,?,?,?,?,NULL)")
        .run(id, kind, 1, json(normalized), now, now);
      this.db
        .prepare("INSERT INTO measurement_revisions VALUES (?,?,?,?)")
        .run(id, 1, json(normalized), now);
    });
    return this.getMeasurement(id)!;
  }

  getMeasurement(
    id: string,
    kind?: MeasurementKind,
  ): LocalMeasurement | undefined {
    const row = this.db
      .prepare("SELECT * FROM measurements WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | undefined;
    return row && (!kind || row.kind === kind) ? measurement(row) : undefined;
  }

  requireMeasurement(id: string, kind?: MeasurementKind): LocalMeasurement {
    const value = this.getMeasurement(id, kind);
    if (!value)
      throw new CliError(
        "usage",
        `Local ${kind ?? "measurement"} ${id} was not found in this workspace.`,
        {
          hint: "List saved measurements with gauge eval list --local or gauge preference list --local.",
        },
      );
    return value;
  }

  listMeasurements(kind?: MeasurementKind): LocalMeasurement[] {
    const rows = kind
      ? this.db
          .prepare(
            "SELECT * FROM measurements WHERE kind = ? AND deleted_at IS NULL ORDER BY created_at DESC,id",
          )
          .all(kind)
      : this.db
          .prepare(
            "SELECT * FROM measurements WHERE deleted_at IS NULL ORDER BY created_at DESC,id",
          )
          .all();
    return (rows as Row[]).map(measurement);
  }

  getMeasurementRevision(
    id: string,
    revision: number,
  ): MeasurementDefinition | undefined {
    const row = this.db
      .prepare(
        "SELECT definition FROM measurement_revisions WHERE measurement_id = ? AND revision = ?",
      )
      .get(id, revision);
    return row ? parse(row.definition) : undefined;
  }

  updateMeasurement(
    id: string,
    patch: Partial<MeasurementDefinition>,
  ): LocalMeasurement {
    this.transaction(() => {
      const previous = this.requireMeasurement(id);
      const original = this.getMeasurementRevision(id, previous.revision)!;
      const definition = normalizeDefinition({ ...original, ...patch });
      const revision = previous.revision + 1;
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO measurement_revisions VALUES (?,?,?,?)")
        .run(id, revision, json(definition), now);
      this.db
        .prepare(
          "UPDATE measurements SET definition = ?, revision = ?, updated_at = ? WHERE id = ?",
        )
        .run(json(definition), revision, now, id);
    });
    return this.requireMeasurement(id);
  }

  deleteMeasurement(id: string): void {
    this.requireMeasurement(id);
    this.db
      .prepare("UPDATE measurements SET deleted_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  recordLaunch(
    input: Omit<
      LocalLaunch,
      "id" | "createdAt" | "measurementId" | "measurementRevision"
    > &
      Partial<
        Pick<
          LocalLaunch,
          "id" | "createdAt" | "measurementId" | "measurementRevision"
        >
      >,
  ): LocalLaunch {
    const value: LocalLaunch = {
      ...input,
      id: input.id ?? `l_${randomUUID()}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      measurementId: input.measurementId ?? null,
      measurementRevision: input.measurementRevision ?? null,
    };
    if (
      value.measurementId &&
      (value.measurementRevision === null ||
        !this.getMeasurementRevision(
          value.measurementId,
          value.measurementRevision,
        ))
    ) {
      throw new CliError(
        "usage",
        "Launch must reference an existing measurement revision.",
      );
    }
    this.db
      .prepare("INSERT INTO launches VALUES (?,?,?,?,?,?)")
      .run(
        value.id,
        value.measurementId,
        value.measurementRevision,
        json(value.configuration),
        json(value.provenance),
        value.createdAt,
      );
    return value;
  }

  getLaunch(id: string): LocalLaunch | undefined {
    const row = this.db.prepare("SELECT * FROM launches WHERE id = ?").get(id);
    return row
      ? {
          id: String(row.id),
          measurementId: row.measurement_id as string | null,
          measurementRevision: row.measurement_revision as number | null,
          configuration: parse(row.configuration),
          provenance: parse(row.provenance),
          createdAt: String(row.created_at),
        }
      : undefined;
  }

  upsertSession(input: LocalSessionSummary): StoredLocalSession {
    if (!Number.isInteger(input.attempt) || input.attempt < 1)
      throw new CliError(
        "usage",
        "Session attempt must be a positive integer.",
      );
    this.db
      .prepare(
        `INSERT INTO sessions (
      id,batch_id,launch_id,measurement_id,measurement_kind,measurement_revision,case_path,agent,model,attempt,outcome,ended_by,turns,created_at,ended_at,duration_ms,input_tokens,output_tokens,configuration,provenance
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      batch_id=excluded.batch_id,launch_id=COALESCE(excluded.launch_id,sessions.launch_id),
      measurement_id=COALESCE(excluded.measurement_id,sessions.measurement_id),
      measurement_kind=COALESCE(excluded.measurement_kind,sessions.measurement_kind),
      measurement_revision=COALESCE(excluded.measurement_revision,sessions.measurement_revision),
      case_path=excluded.case_path,agent=excluded.agent,model=excluded.model,
      current_analysis_id=CASE WHEN excluded.attempt=sessions.attempt THEN sessions.current_analysis_id ELSE NULL END,
      attempt=excluded.attempt,outcome=excluded.outcome,ended_by=excluded.ended_by,turns=excluded.turns,
      ended_at=excluded.ended_at,duration_ms=COALESCE(excluded.duration_ms,sessions.duration_ms),
      input_tokens=COALESCE(excluded.input_tokens,sessions.input_tokens),output_tokens=COALESCE(excluded.output_tokens,sessions.output_tokens),
      configuration=CASE WHEN excluded.configuration='{}' THEN sessions.configuration ELSE excluded.configuration END,
      provenance=CASE WHEN excluded.provenance='{}' THEN sessions.provenance ELSE excluded.provenance END
    WHERE excluded.attempt >= sessions.attempt`,
      )
      .run(
        input.id,
        input.batchId,
        input.launchId ?? null,
        input.measurementId ?? null,
        input.measurementKind ?? null,
        input.measurementRevision ?? null,
        input.case,
        input.agent,
        input.model,
        input.attempt,
        input.outcome,
        input.endedBy,
        input.turns,
        input.createdAt,
        input.endedAt,
        input.durationMs ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        json(input.configuration ?? {}),
        json(input.provenance ?? {}),
      );
    return this.getSession(input.id)!;
  }

  getSession(id: string): StoredLocalSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? session(row) : undefined;
  }

  listSessions(
    filter: {
      measurementId?: string;
      measurementKind?: MeasurementKind;
      batchId?: string;
    } = {},
  ): StoredLocalSession[] {
    const conditions: string[] = [];
    const values: string[] = [];
    for (const [key, column] of [
      ["measurementId", "measurement_id"],
      ["measurementKind", "measurement_kind"],
      ["batchId", "batch_id"],
    ] as const) {
      if (filter[key] !== undefined) {
        conditions.push(`${column} = ?`);
        values.push(filter[key]);
      }
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY COALESCE(ended_at,created_at) DESC,id`,
        )
        .all(...values) as Row[]
    ).map(session);
  }

  repairSessionSummaries(ids?: readonly string[]): {
    repaired: number;
    skipped: string[];
  } {
    const runs = join(this.gaugeDir, "runs");
    if (!existsSync(runs)) return { repaired: 0, skipped: [] };
    let repaired = 0;
    const skipped: string[] = [];
    for (const entry of readdirSync(runs, { withFileTypes: true })) {
      if (!entry.isDirectory() || (ids && !ids.includes(entry.name))) continue;
      const attempts = join(runs, entry.name, "attempts");
      if (!existsSync(attempts)) continue;
      const n = readdirSync(attempts)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
        .sort((a, b) => b - a)[0];
      if (n === undefined) continue;
      try {
        const directory = join(attempts, String(n));
        const spec = object(readJson(join(directory, "spec.json")));
        const attempt = object(spec.attempt);
        const agent = object(spec.agent);
        if (
          attempt.runId !== entry.name ||
          attempt.n !== n ||
          typeof attempt.batchId !== "string" ||
          typeof agent.kind !== "string" ||
          typeof agent.model !== "string"
        )
          throw new Error("invalid spec.json");
        const result = object(readJson(join(directory, "result.json")));
        const status = object(
          readJson(join(directory, "session", "status.json")),
        );
        const item = object(spec.case);
        const association = object(spec.measurement);
        const previous = this.getSession(entry.name);
        const createdAt =
          typeof spec.createdAt === "string"
            ? spec.createdAt
            : (previous?.createdAt ??
              statSync(join(directory, "spec.json")).mtime.toISOString());
        this.upsertSession({
          id: entry.name,
          batchId: attempt.batchId,
          launchId: typeof spec.launchId === "string" ? spec.launchId : null,
          measurementId:
            typeof association.id === "string" ? association.id : null,
          measurementKind:
            association.kind === "eval" || association.kind === "preference"
              ? association.kind
              : null,
          measurementRevision:
            typeof association.revision === "number"
              ? association.revision
              : null,
          case: typeof item.path === "string" ? item.path : null,
          agent:
            typeof spec.agentName === "string" ? spec.agentName : agent.kind,
          model: agent.model,
          attempt: n,
          outcome: String(result.outcome ?? status.state ?? "queued"),
          endedBy: typeof result.endedBy === "string" ? result.endedBy : null,
          turns:
            typeof result.turns === "number"
              ? result.turns
              : typeof status.turn === "number"
                ? status.turn
                : null,
          createdAt,
          endedAt: typeof result.endedAt === "string" ? result.endedAt : null,
          durationMs: numberOrNull(result.durationMs),
          inputTokens: numberOrNull(result.inputTokens),
          outputTokens: numberOrNull(result.outputTokens),
          configuration: { ...object(spec.configuration), case: item },
          provenance: object(spec.provenance),
        });
        repaired++;
      } catch (error) {
        skipped.push(
          `${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { repaired, skipped };
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function normalizeDefinition(
  definition: MeasurementDefinition,
): MeasurementDefinition & { tags: string[] } {
  if (!definition.name?.trim() || !definition.promptText?.trim())
    throw new CliError(
      "usage",
      "A local measurement requires a nonempty name and promptText.",
    );
  if (
    definition.tags &&
    (!Array.isArray(definition.tags) ||
      definition.tags.some((tag) => typeof tag !== "string" || !tag.trim()))
  )
    throw new CliError("usage", "Measurement tags must be nonempty strings.");
  for (const key of [
    "id",
    "measurementKind",
    "revision",
    "createdAt",
    "updatedAt",
  ]) {
    if (key in definition)
      throw new CliError(
        "usage",
        `Measurement field ${key} is assigned by Gauge.`,
      );
  }
  return { ...definition, tags: [...new Set(definition.tags ?? [])] };
}
function measurement(row: Row): LocalMeasurement {
  return {
    ...parse(row.definition),
    id: String(row.id),
    measurementKind: row.kind as MeasurementKind,
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
function session(row: Row): StoredLocalSession {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    launchId: row.launch_id as string | null,
    measurementId: row.measurement_id as string | null,
    measurementKind: row.measurement_kind as MeasurementKind | null,
    measurementRevision: row.measurement_revision as number | null,
    case: row.case_path as string | null,
    agent: String(row.agent),
    model: String(row.model),
    attempt: Number(row.attempt),
    outcome: String(row.outcome),
    endedBy: row.ended_by as string | null,
    turns: row.turns as number | null,
    createdAt: String(row.created_at),
    endedAt: row.ended_at as string | null,
    durationMs: row.duration_ms as number | null,
    inputTokens: row.input_tokens as number | null,
    outputTokens: row.output_tokens as number | null,
    configuration: parse(row.configuration),
    provenance: parse(row.provenance),
    currentAnalysisId: row.current_analysis_id as string | null,
    analyzed: row.current_analysis_id !== null,
  };
}

export function openLocalStore(gaugeDir: string): LocalStore {
  mkdirSync(gaugeDir, { recursive: true, mode: 0o700 });
  const path = join(gaugeDir, "gauge.sqlite");
  const { DatabaseSync: SQLite } = loadSQLite();
  const db = new SQLite(path);
  try {
    chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const version = Number(
      db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version > LOCAL_DATABASE_VERSION)
      throw new CliError(
        "usage",
        `This workspace uses database version ${version}; this CLI supports ${LOCAL_DATABASE_VERSION}. Upgrade Gauge. Your data has not been changed.`,
      );
    db.exec("PRAGMA journal_mode = WAL;");
    if (version === 0) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (Number(db.prepare("PRAGMA user_version").get()!.user_version) === 0)
          db.exec(schema);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return new LocalStore(gaugeDir, db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function loadSQLite(): typeof import("node:sqlite") {
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...args: unknown[]) => {
    if (
      warning ===
        "SQLite is an experimental feature and might change at any time" &&
      args[0] === "ExperimentalWarning"
    )
      return;
    Reflect.apply(emitWarning, process, [warning, ...args]);
  };
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = emitWarning;
  }
}
