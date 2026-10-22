import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { billing } from "@withgauge/api-schemas";
import { usageRow } from "./usage";

describe("usage", () => {
  const entry = (
    triggeredBy?: billing.UsageEntry["triggeredBy"],
  ): billing.UsageEntry => ({
    id: "l1",
    kind: "RUN_DEBIT",
    delta: -3,
    runId: "r1",
    batchId: "b1",
    createdAt: "2026-10-21T00:00:00.000Z",
    ...(triggeredBy === undefined ? {} : { triggeredBy }),
  });

  it("labels who started the session each entry charges", () => {
    assert.deepEqual(
      [
        entry({ source: "API", userId: "u1", email: "ann@acme.test" }),
        entry({ source: "STAFF", userId: null, email: null }),
        entry(null),
        entry(),
      ].map((e) => usageRow(e)["started by"]),
      ["API (ann@acme.test)", "STAFF", "", ""],
    );
  });
});
