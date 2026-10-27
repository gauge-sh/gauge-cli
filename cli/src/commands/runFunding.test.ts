import assert from "node:assert/strict";
import { it } from "node:test";
import { Command } from "commander";
import { register } from "./run";

for (const [flag, path] of [
  ["--eval", "eval-sets"],
  ["--preference", "visibility-prompts"],
] as const) {
  it(`run ${flag} uses default funding in the selected org`, async (t) => {
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
    const requests: { url: string; body: unknown }[] = [];
    t.mock.method(console, "log", () => {});
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ batchIds: ["batch"], runIds: ["run"] });
      },
    );
    const command = new Command()
      .option("--hosted", "hosted", true)
      .option("--org <org>");
    register(command);
    await command.parseAsync(
      [
        "--org",
        "8c7f0e1a-1111-4222-8333-944455556666",
        "run",
        flag,
        "target",
        "--yes",
      ],
      { from: "user" },
    );
    assert.deepEqual(requests, [
      {
        url: `https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/${path}/target/run`,
        body: {},
      },
    ]);
  });
}
