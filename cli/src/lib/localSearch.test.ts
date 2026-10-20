import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { searchLocalTranscripts } from "./localSearch";
import { openLocalStore } from "./localStore";

test("transcript search narrows the session cohort and returns resolvable line evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "gauge-search-"));
  const store = openLocalStore(root);
  try {
    for (const id of ["one", "two", "missing"]) {
      store.upsertSession({
        id,
        batchId: "batch",
        measurementId: id === "two" ? "other" : "eval_a",
        measurementKind: "eval",
        measurementRevision: 1,
        case: null,
        agent: "codex",
        model: "gpt-6",
        attempt: 1,
        outcome: "completed",
        endedBy: "session",
        turns: 1,
        createdAt: "2026-10-01T00:00:00.000Z",
        endedAt: "2026-10-01T00:01:00.000Z",
      });
      if (id === "missing") continue;
      const dir = join(root, "runs", id, "attempts", "1", "session");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "events.ndjson"),
        [
          JSON.stringify({
            turn: 1,
            payload: { text: "Authentication failed" },
          }),
          JSON.stringify({
            turn: 2,
            payload: { text: "Authentication failed again" },
          }),
          '{"turn":3',
        ].join("\n"),
      );
    }
    const result = await searchLocalTranscripts(root, "authentication failed", {
      eval: "eval_a",
    });
    assert.equal(result.selectedSessions, 2);
    assert.equal(result.scannedSessions, 1);
    assert.deepEqual(result.missingArtifacts, ["missing"]);
    assert.deepEqual(
      result.matches.map((match) => [match.run, match.turn, match.line]),
      [
        ["one", 1, 1],
        ["one", 2, 2],
      ],
    );
    assert.equal(result.matches[0].artifact, "session/events.ndjson");
    const limited = await searchLocalTranscripts(root, "authentication", {
      eval: "eval_a",
      limit: 1,
    });
    assert.equal(limited.matches.length, 1);
    assert.equal(limited.truncated, true);
    const none = await searchLocalTranscripts(root, "authentication", {
      since: new Date("2026-10-02"),
    });
    assert.equal(none.selectedSessions, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
