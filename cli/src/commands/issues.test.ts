import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Command } from "commander";
import { impactLine, register } from "./issues";

describe("impactLine", () => {
  it("shows effects for problems and destinations for reasons", () => {
    assert.equal(
      impactLine({
        impact: [
          { effect: "BLOCKED", sessions: 3 },
          { effect: "EXTRA_WORK", sessions: 2 },
        ],
        wentTo: [],
      }),
      "blocked 3, extra work 2",
    );
    assert.equal(
      impactLine({ impact: null, wentTo: [{ name: "Neon", sessions: 4 }] }),
      "Neon 4",
    );
  });
});

describe("issues command requests", () => {
  for (const [args, suffix] of [
    [["list"], "?kind=problems"],
    [["list", "--reasons"], "?kind=reasons"],
    [["get", "is_1"], "/is_1"],
  ] as const) {
    it(`${args.join(" ")} maps to the correct API request`, async (t) => {
      const previous = {
        token: process.env.GAUGE_API_TOKEN,
        url: process.env.GAUGE_API_URL,
      };
      process.env.GAUGE_API_TOKEN = "gauge_test";
      process.env.GAUGE_API_URL = "https://test.invalid";
      t.after(() => {
        if (previous.token === undefined) delete process.env.GAUGE_API_TOKEN;
        else process.env.GAUGE_API_TOKEN = previous.token;
        if (previous.url === undefined) delete process.env.GAUGE_API_URL;
        else process.env.GAUGE_API_URL = previous.url;
      });
      const urls: string[] = [];
      t.mock.method(console, "log", () => {});
      t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
        urls.push(String(url));
        return Response.json({ blocks: [], instances: [] });
      });
      const command = new Command()
        .option("--hosted", "use hosted", true)
        .option("--org <org>")
        .option("-o, --output <output>");
      register(command);
      await command.parseAsync(
        [
          "--org",
          "8c7f0e1a-1111-4222-8333-944455556666",
          "-o",
          "json",
          "issues",
          ...args,
        ],
        { from: "user" },
      );
      assert.deepEqual(urls, [
        `https://test.invalid/api/v1/orgs/8c7f0e1a-1111-4222-8333-944455556666/issues${suffix}`,
      ]);
    });
  }
});
