import { createReadStream, existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { CliError } from "./client";
import { openLocalStore } from "./localStore";

export type LocalSearchOptions = {
  eval?: string;
  preference?: string;
  batch?: string;
  since?: Date;
  limit?: number;
};
export type LocalSearchMatch = {
  run: string;
  attempt: number;
  turn: number | null;
  artifact: string;
  line: number;
  snippet: string;
};
export type LocalSearchResult = {
  matches: LocalSearchMatch[];
  selectedSessions: number;
  scannedSessions: number;
  missingArtifacts: string[];
  truncated: boolean;
};

export async function searchLocalTranscripts(
  gaugeDir: string,
  text: string,
  options: LocalSearchOptions = {},
): Promise<LocalSearchResult> {
  if (!text.trim())
    throw new CliError("usage", "Transcript search requires nonempty text.");
  if (options.eval && options.preference)
    throw new CliError(
      "usage",
      "Select either --eval or --preference for transcript search.",
    );
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    throw new CliError(
      "usage",
      "Search limit must be an integer from 1 to 1000.",
    );
  const store = openLocalStore(gaugeDir);
  const sessions = (() => {
    try {
      return store
        .listSessions({
          measurementId: options.eval ?? options.preference,
          measurementKind: options.eval
            ? "eval"
            : options.preference
              ? "preference"
              : undefined,
          batchId: options.batch,
        })
        .filter(
          (session) =>
            !options.since ||
            Date.parse(session.createdAt) >= options.since.getTime(),
        );
    } finally {
      store.close();
    }
  })();
  const result: LocalSearchResult = {
    matches: [],
    selectedSessions: sessions.length,
    scannedSessions: 0,
    missingArtifacts: [],
    truncated: false,
  };
  const needle = text.toLowerCase();
  for (const session of sessions) {
    if (!/^[A-Za-z0-9_-]+$/.test(session.id))
      throw new CliError("usage", `Invalid local run ID: ${session.id}`);
    const attemptDir = join(
      gaugeDir,
      "runs",
      session.id,
      "attempts",
      String(session.attempt),
    );
    const path = join(attemptDir, "session", "events.ndjson");
    if (!existsSync(path)) {
      result.missingArtifacts.push(session.id);
      continue;
    }
    const rel = relative(realpathSync(attemptDir), realpathSync(path));
    if (
      isAbsolute(rel) ||
      rel === ".." ||
      rel.startsWith("../") ||
      rel.startsWith("..\\")
    )
      throw new CliError(
        "usage",
        `Run ${session.id} transcript resolves outside its attempt.`,
      );
    result.scannedSessions++;
    const stream = createReadStream(path, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of lines) {
        lineNumber++;
        let event: { turn?: unknown; payload?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || typeof event !== "object") continue;
        const content =
          typeof event.payload === "string"
            ? event.payload
            : JSON.stringify(event.payload ?? event);
        const index = content.toLowerCase().indexOf(needle);
        if (index < 0) continue;
        if (result.matches.length === limit) {
          result.truncated = true;
          return result;
        }
        const start = Math.max(0, index - 100);
        const end = Math.min(
          content.length,
          Math.max(index + needle.length + 200, start + 400),
        );
        result.matches.push({
          run: session.id,
          attempt: session.attempt,
          turn: typeof event.turn === "number" ? event.turn : null,
          artifact: "session/events.ndjson",
          line: lineNumber,
          snippet: `${start ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`,
        });
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return result;
}
