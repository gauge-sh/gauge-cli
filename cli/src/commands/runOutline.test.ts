import assert from "node:assert/strict";
import { it } from "node:test";
import { sessionAnalysisSchema } from "../../api-schemas/sessionAnalysis";
import { outlineLines } from "./run";

it("prints each part with an aligned seq range", () => {
  assert.deepEqual(
    outlineLines([
      { title: "Read the docs", seqStart: 0, seqEnd: 9, outcome: null },
      { title: "Install", seqStart: 100, seqEnd: 120, outcome: null },
      { title: "Report", seqStart: 121, seqEnd: 121, outcome: null },
    ]),
    [
      "  seq 0-9      Read the docs",
      "  seq 100-120  Install",
      "  seq 121      Report",
    ],
  );
});

it("accepts an analysis from a server without outlines", () => {
  const base = {
    schemaVersion: 1,
    instructionsVersion: "1",
    id: "a1",
    runId: "r1",
    attempt: 1,
    createdAt: "2026-11-20T00:00:00.000Z",
    origin: "MODEL",
    model: null,
    assessability: "ASSESSED",
    limitation: null,
    selection: "MEASURED",
    directed: false,
    products: [],
    observations: [],
  };
  assert.equal(sessionAnalysisSchema.parse(base).outline, undefined);
  assert.equal(
    sessionAnalysisSchema.parse({ ...base, outline: null }).outline,
    null,
  );
});
