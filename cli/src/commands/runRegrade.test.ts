import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import { regradeRunResponseSchema } from "../../api-schemas/runs";
import { register } from "./run";

for (const evalSetId of ["eval-1", null]) {
  it(`regrades ${evalSetId ?? "snapshot criteria"} without displaying a null eval`, async (t) => {
    const previousToken = process.env.GAUGE_API_TOKEN;
    const previousUrl = process.env.GAUGE_API_URL;
    process.env.GAUGE_API_TOKEN = "gauge_test";
    process.env.GAUGE_API_URL = "https://test.invalid";
    t.after(() => {
      if (previousToken === undefined) delete process.env.GAUGE_API_TOKEN;
      else process.env.GAUGE_API_TOKEN = previousToken;
      if (previousUrl === undefined) delete process.env.GAUGE_API_URL;
      else process.env.GAUGE_API_URL = previousUrl;
    });
    const output: string[] = [];
    t.mock.method(console, "log", (line: string) => output.push(line));
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL | Request, init?: RequestInit) => {
        assert.equal(
          String(url),
          "https://test.invalid/api/v1/runs/run-1/regrade",
        );
        assert.equal(init?.method, "POST");
        return Response.json(
          regradeRunResponseSchema.parse({
            runId: "run-1",
            evalSetId,
            criteria: 3,
          }),
        );
      },
    );
    const command = new Command().option("--hosted", "use hosted", true);
    register(command);
    await command.parseAsync(["run", "regrade", "run-1"], { from: "user" });
    assert.equal(
      output[0],
      evalSetId
        ? "Re-judging run run-1 against 3 criteria of eval eval-1."
        : "Re-judging run run-1 against 3 criteria from its launch-time snapshot.",
    );
  });
}
