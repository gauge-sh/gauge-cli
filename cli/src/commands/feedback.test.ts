import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Command } from "commander";
import { CliError } from "../lib/client";
import { register } from "./feedback";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

function setEnv(t: TestContext, values: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(values)) {
    const old = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (old === undefined) delete process.env[key];
      else process.env[key] = old;
    });
  }
}

async function sendFeedback(
  t: TestContext,
  {
    token,
    respond,
    args = [],
  }: {
    token?: string;
    respond: () => Response | Promise<Response>;
    args?: string[];
  },
): Promise<{ sent: Sent[]; stdout: string[]; error?: unknown }> {
  const config = mkdtempSync(join(tmpdir(), "gauge-feedback-"));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  setEnv(t, {
    XDG_CONFIG_HOME: config,
    GAUGE_API_TOKEN: token,
    GAUGE_API_URL: "https://test.invalid",
  });
  const sent: Sent[] = [];
  const stdout: string[] = [];
  t.mock.method(console, "log", (line: string) => stdout.push(line));
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, init: RequestInit) => {
      sent.push({
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(String(init.body)),
      });
      return respond();
    },
  );
  const program = new Command()
    .option("--org <org>")
    .option("-o, --output <format>");
  register(program);
  let error: unknown;
  try {
    await program.parseAsync(
      [...args, "feedback", "-m", "it broke", "--kind", "bug"],
      { from: "user" },
    );
  } catch (caught) {
    error = caught;
  }
  return { sent, stdout, error };
}

const created = () => Response.json({ id: "fb_1" }, { status: 201 });

describe("gauge feedback", () => {
  it("sends anonymously without a token, and without an org", async (t) => {
    const { sent, stdout, error } = await sendFeedback(t, {
      respond: created,
      args: ["--org", "acme"],
    });
    assert.equal(error, undefined);
    assert.equal(sent[0].url, "https://test.invalid/api/v1/feedback");
    assert.equal(sent[0].headers.get("authorization"), null);
    assert.match(sent[0].headers.get("user-agent") ?? "", /gauge/i);
    assert.equal(sent[0].body.org, undefined);
    assert.deepEqual(stdout, ["Feedback sent (fb_1, anonymous). Thank you."]);
  });

  it("sends the token and org when signed in", async (t) => {
    const { sent, stdout } = await sendFeedback(t, {
      token: "gauge_test",
      respond: created,
      args: ["--org", "acme"],
    });
    assert.equal(sent[0].headers.get("authorization"), "Bearer gauge_test");
    assert.equal(sent[0].body.org, "acme");
    assert.deepEqual(stdout, ["Feedback sent (fb_1). Thank you."]);
  });

  it("names the host and cause on a network failure", async (t) => {
    const { error } = await sendFeedback(t, {
      respond: () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "network");
    assert.match(error.message, /test\.invalid failed: fetch failed/);
  });

  it("says when to retry after a rate limit", async (t) => {
    const { error } = await sendFeedback(t, {
      respond: () =>
        new Response("", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "30" },
        }),
    });
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "rate_limited");
    assert.match(error.message, /Rate limited/);
    assert.equal(error.hint, "Try again in 30 s.");
  });

  it("shows the validation message for a bad request", async (t) => {
    const { error } = await sendFeedback(t, {
      respond: () =>
        Response.json(
          {
            error: {
              code: "invalid_request",
              message: "message: too long",
            },
          },
          { status: 400 },
        ),
    });
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.message, "message: too long");
  });

  it("reports a server error", async (t) => {
    const { error } = await sendFeedback(t, {
      respond: () =>
        new Response("", { status: 503, statusText: "Service Unavailable" }),
    });
    assert.ok(error instanceof CliError);
    assert.match(error.message, /Gauge API server error: HTTP 503/);
  });
});
