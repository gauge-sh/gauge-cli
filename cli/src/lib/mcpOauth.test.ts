import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { mcp } from "@withgauge/api-schemas";
import { CliError } from "./client";
import { connectMcpOauth } from "./mcpOauth";

const input = { name: "gauge", url: "https://app.withgauge.com/mcp" };
const redirect: mcp.BeginMcpOauthResponse = {
  kind: "redirect",
  authorizationId: "pending/1",
  authorizationUrl: "https://app.withgauge.com/authorize?state=signed",
  expiresAt: new Date(600_000).toISOString(),
};
function harness(
  begin: mcp.BeginMcpOauthResponse = redirect,
  statuses: mcp.McpOauthStatus[] = [
    { status: "connected", connectionId: "conn" },
  ],
) {
  let now = 0;
  const calls: string[] = [];
  const opened: string[] = [];
  const messages: string[] = [];
  const client = {
    post: async <T>(path: string) => {
      calls.push(path);
      return begin as T;
    },
    get: async <T>(path: string) => {
      calls.push(path);
      return (statuses.length > 1 ? statuses.shift() : statuses[0]) as T;
    },
  };
  const deps = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    openBrowser: (url: string) => {
      opened.push(url);
    },
    report: (message: string) => {
      messages.push(message);
    },
  };
  return { client, deps, calls, opened, messages };
}
describe("MCP browser authorization", () => {
  it("opens consent and polls before returning only the connection id", async () => {
    const h = harness(redirect, [
      { status: "pending", expiresAt: redirect.expiresAt },
      { status: "connected", connectionId: "conn" },
    ]);
    assert.equal(
      await connectMcpOauth(
        h.client,
        "my/org",
        input,
        { browser: true, timeoutSeconds: 600 },
        h.deps,
      ),
      "conn",
    );
    assert.deepEqual(h.opened, [redirect.authorizationUrl]);
    assert.equal(
      h.calls[1],
      "/api/v1/orgs/my%2Forg/mcp-servers/oauth/pending%2F1",
    );
    assert.equal(h.calls.length, 3);
  });
  it("prints the URL without opening a browser for headless use", async () => {
    const h = harness();
    await connectMcpOauth(
      h.client,
      "org",
      input,
      { browser: false, timeoutSeconds: 600 },
      h.deps,
    );
    assert.equal(h.opened.length, 0);
    assert.match(h.messages[0], /https:\/\/app.withgauge.com\/authorize/);
  });
  it("handles a resumed saved grant without asking for consent again", async () => {
    const h = harness({
      kind: "connected",
      connectionId: "saved",
      handle: "gauge",
    });
    assert.equal(
      await connectMcpOauth(
        h.client,
        "org",
        input,
        { browser: true, timeoutSeconds: 600 },
        h.deps,
      ),
      "saved",
    );
    assert.equal(h.opened.length, 0);
    assert.equal(h.calls.length, 1);
  });
  it("explains manual client registration without claiming connection success", async () => {
    const h = harness({
      kind: "needs-client-id",
      redirectUri: "https://agents.example/callback",
      reason: "No dynamic registration",
    });
    await assert.rejects(
      connectMcpOauth(
        h.client,
        "org",
        input,
        { browser: false, timeoutSeconds: 600 },
        h.deps,
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.hint?.includes("--oauth-client-id") === true,
    );
    assert.equal(h.calls.length, 1);
  });
  for (const status of ["failed", "expired"] as const)
    it(`stops on ${status} consent`, async () => {
      const h = harness(redirect, [{ status, message: "Consent unavailable" }]);
      await assert.rejects(
        connectMcpOauth(
          h.client,
          "org",
          input,
          { browser: false, timeoutSeconds: 600 },
          h.deps,
        ),
        /Consent unavailable/,
      );
      assert.equal(h.calls.length, 2);
    });
  it("times out and explains how to reuse a connection if consent completed late", async () => {
    const h = harness(redirect, [
      { status: "pending", expiresAt: redirect.expiresAt },
    ]);
    await assert.rejects(
      connectMcpOauth(
        h.client,
        "org",
        input,
        { browser: false, timeoutSeconds: 1 },
        h.deps,
      ),
      (error: unknown) =>
        error instanceof CliError &&
        error.hint?.includes("--connection") === true,
    );
    assert.equal(h.calls.length, 2);
  });
  it("does not open a non-HTTPS authorization URL", async () => {
    const h = harness({ ...redirect, authorizationUrl: "file:///tmp/unsafe" });
    await assert.rejects(
      connectMcpOauth(
        h.client,
        "org",
        input,
        { browser: true, timeoutSeconds: 600 },
        h.deps,
      ),
      /unsafe authorization URL/,
    );
    assert.equal(h.opened.length, 0);
  });
});
