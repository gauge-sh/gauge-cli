import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, it, mock } from "node:test";
import { ensureAccount } from "./account";
import { ApiClient, createChatClient } from "./client";
import {
  credentialsPath,
  readCredentials,
  resolveToken,
  saveCredentials,
  saveToken,
  type SharedCredentials,
} from "./credentials";
import { sharedTokenSchema } from "./sharedAuth";
import {
  browserLogin,
  deviceLogin,
  logout,
  parseLoopbackCallback,
} from "../commands/auth";

const tokens = (suffix = "new") => ({
  accessToken: `gauge_cli_${suffix}`,
  refreshToken: `gauge_refresh_${suffix}`,
  tokenType: "bearer",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const credentials = (expired = false): SharedCredentials => ({
  version: 1,
  ...tokens("old"),
  expiresAt: new Date(Date.now() + (expired ? -1000 : 3600000)).toISOString(),
  authUrl: "https://chat.test",
  apiUrl: "https://agents.test",
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("shared CLI credentials", { concurrency: false }, () => {
  let saved: NodeJS.ProcessEnv;
  let directory: string;
  beforeEach(() => {
    saved = { ...process.env };
    directory = mkdtempSync(join(tmpdir(), "gauge-auth-"));
    process.env.XDG_CONFIG_HOME = directory;
    delete process.env.GAUGE_API_TOKEN;
    process.env.GAUGE_API_URL = "https://agents.test";
    process.env.GAUGE_AUTH_URL = "https://chat.test";
  });
  afterEach(() => {
    mock.restoreAll();
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  });

  it("handles browser denial only for the matching login state", () => {
    assert.throws(
      () =>
        parseLoopbackCallback("/callback?state=ok&error=access_denied", "ok"),
      /denied/,
    );
    assert.equal(
      parseLoopbackCallback("/callback?state=wrong&error=access_denied", "ok"),
      null,
    );
  });

  it("uses Chat device endpoints and verifies Chat-only users while retaining refresh metadata", async () => {
    const seen: string[] = [];
    mock.method(console, "log", () => {});
    mock.method(globalThis, "fetch", async (url: URL | string) => {
      seen.push(String(url));
      if (String(url).endsWith("/authorize"))
        return json({
          deviceCode: "secret",
          userCode: "CODE",
          verificationUriComplete: "https://chat.test/device",
          interval: 0,
          expiresIn: 60,
          emailSent: false,
        });
      if (String(url).endsWith("/token"))
        return json({ status: "approved", ...tokens() });
      return json({
        user: { id: "uuid", email: "person@test.com", name: "Person" },
        orgs: [],
      });
    });
    const result = await deviceLogin({});
    assert.equal(result.credentials?.refreshToken, "gauge_refresh_new");
    assert.equal(result.me.orgs.length, 0);
    assert.deepEqual(seen, [
      "https://chat.test/api/cli/device/authorize",
      "https://chat.test/api/cli/device/token",
      "https://chat.test/api/cli/me",
    ]);
  });

  it("resolves Agents workspaces separately during shared onboarding", async () => {
    mock.method(console, "log", () => {});
    const seen: string[] = [];
    mock.method(globalThis, "fetch", async (url: URL | string) => {
      seen.push(String(url));
      if (String(url).endsWith("/authorize"))
        return json({
          deviceCode: "secret",
          userCode: "CODE",
          verificationUriComplete: "https://chat.test/device",
          interval: 0,
          expiresIn: 60,
          emailSent: false,
        });
      if (String(url).endsWith("/token"))
        return json({ status: "approved", ...tokens() });
      if (String(url).includes("chat.test"))
        return json({
          user: { id: "uuid", email: "person@test.com", name: "Person" },
          orgs: [{ id: "canonical", slug: "chat-slug", name: "Org" }],
        });
      return json({
        user: { id: "agents-user", email: "person@test.com" },
        orgs: [{ publicId: "public", slug: "agents-slug", name: "Org" }],
      });
    });
    const result = await ensureAccount({ seed: false });
    assert.equal(result.org, "agents-slug");
    assert.equal(seen.at(-1), "https://agents.test/api/v1/me");
    assert.equal(
      (readCredentials() as SharedCredentials).refreshToken,
      "gauge_refresh_new",
    );
  });

  it("exchanges the browser callback with PKCE at Chat and saves a refreshable session", async () => {
    const originalFetch = globalThis.fetch;
    let authorize: URL | undefined;
    let callback: Promise<Response> | undefined;
    mock.method(console, "log", (message: string) => {
      const match = message.match(/https:\/\/chat\.test\/cli\/authorize\?\S+/);
      if (!match) return;
      authorize = new URL(match[0]);
      callback = originalFetch(
        `http://127.0.0.1:${authorize.searchParams.get("port")}/callback?state=${authorize.searchParams.get("state")}&code=one-time`,
      );
    });
    mock.method(
      globalThis,
      "fetch",
      async (url: URL | string, init: RequestInit) => {
        if (String(url).endsWith("/token")) {
          const body = JSON.parse(init.body as string);
          assert.equal(body.code, "one-time");
          assert.equal(
            createHash("sha256").update(body.codeVerifier).digest("base64url"),
            authorize?.searchParams.get("code_challenge"),
          );
          return json(tokens());
        }
        assert.equal(String(url), "https://chat.test/api/cli/me");
        return json({
          user: { id: "uuid", email: "person@test.com" },
          orgs: [],
        });
      },
    );
    await browserLogin();
    await callback;
    assert.equal(
      (readCredentials() as SharedCredentials).refreshToken,
      "gauge_refresh_new",
    );
  });

  it("serializes rotating refreshes across independent processes", async () => {
    let refreshes = 0;
    const server = createServer((_req, res) => {
      refreshes++;
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(tokens()));
      }, 80);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    saveCredentials({
      ...credentials(true),
      authUrl: `http://127.0.0.1:${address.port}`,
    });
    const script = `import { readCredentials } from './src/lib/credentials.ts'; import { refreshCredentials } from './src/lib/sharedAuth.ts'; void refreshCredentials(readCredentials() as any).then(c => console.log(c.accessToken));`;
    try {
      const results = await Promise.all(
        [1, 2].map(() =>
          promisify(execFile)(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              script.replace(" as any", ""),
            ],
            { cwd: process.cwd(), env: process.env },
          ),
        ),
      );
      assert.equal(refreshes, 1);
      for (const result of results)
        assert.match(result.stdout, /gauge_cli_new/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retains legacy plaintext credentials and environment precedence", () => {
    saveToken("gauge_legacy");
    assert.equal(resolveToken(), "gauge_legacy");
    saveCredentials(credentials());
    assert.equal(resolveToken(), "gauge_cli_old");
    assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(readFileSync(credentialsPath(), "utf8")).refreshToken,
      "gauge_refresh_old",
    );
    process.env.GAUGE_API_TOKEN = "gauge_env";
    assert.equal(resolveToken(), "gauge_env");
  });

  it("validates browser and approved device token payloads without dropping refresh data", () => {
    assert.equal(
      sharedTokenSchema.parse(tokens()).refreshToken,
      "gauge_refresh_new",
    );
    assert.equal(
      sharedTokenSchema.parse({ status: "approved", ...tokens() }).refreshToken,
      "gauge_refresh_new",
    );
    assert.equal(
      sharedTokenSchema.safeParse({ ...tokens(), refreshToken: undefined })
        .success,
      false,
    );
  });

  it("refreshes once across concurrent clients and sends the same token to both services", async () => {
    saveCredentials(credentials(true));
    let refreshes = 0;
    const seen: string[] = [];
    mock.method(
      globalThis,
      "fetch",
      async (url: URL | string, init: RequestInit) => {
        if (String(url).endsWith("/refresh")) {
          refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return json(tokens());
        }
        seen.push(new Headers(init.headers).get("authorization")!);
        return json({ ok: true });
      },
    );
    await Promise.all([
      new ApiClient().get("/api/v1/me"),
      createChatClient().get("/api/cli/me"),
    ]);
    assert.equal(refreshes, 1);
    assert.deepEqual(seen, ["Bearer gauge_cli_new", "Bearer gauge_cli_new"]);
  });

  it("refreshes once after a definite 401, including SSE handshakes", async () => {
    saveCredentials(credentials());
    let refreshes = 0;
    let requests = 0;
    mock.method(globalThis, "fetch", async (url: URL | string) => {
      if (String(url).endsWith("/refresh")) {
        refreshes++;
        return json(tokens());
      }
      requests++;
      return requests === 1
        ? json({}, 401)
        : new Response("event: done\ndata: ok\n\n");
    });
    const events: unknown[] = [];
    await new ApiClient().sse("/events", (event) => events.push(event));
    assert.equal(refreshes, 1);
    assert.equal(requests, 2);
    assert.deepEqual(events, [{ event: "done", data: "ok" }]);
  });

  it("does not refresh manual or environment tokens", async () => {
    saveCredentials(credentials(true));
    process.env.GAUGE_API_TOKEN = "gauge_env";
    const seen: string[] = [];
    mock.method(globalThis, "fetch", async (_url: URL, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("authorization")!);
      return json({});
    });
    await new ApiClient().get("/me");
    await new ApiClient({ token: "gauge_manual" }).get("/me");
    assert.deepEqual(seen, ["Bearer gauge_env", "Bearer gauge_manual"]);
  });

  it("preserves credentials during Chat outages and never retries ambiguous mutations", async () => {
    const original = credentials(true);
    saveCredentials(original);
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls++;
      throw new Error("unavailable");
    });
    await assert.rejects(new ApiClient().post("/mutate", {}), /unavailable/);
    assert.deepEqual(readCredentials(), original);
    assert.equal(calls, 1);
    saveCredentials(credentials());
    calls = 0;
    await assert.rejects(new ApiClient().post("/mutate", {}), /unavailable/);
    assert.equal(calls, 1);
  });

  it("distinguishes refresh outages from invalid credentials after a 401", async () => {
    saveCredentials(credentials());
    mock.method(globalThis, "fetch", async (url: URL | string) =>
      json({}, String(url).endsWith("/refresh") ? 503 : 401),
    );
    await assert.rejects(new ApiClient().get("/me"), (error: unknown) => {
      assert.equal((error as { code: string }).code, "network");
      return true;
    });
    assert.equal(resolveToken(), "gauge_cli_old");
  });

  it("keeps using an unexpired access token during a proactive refresh outage", async () => {
    saveCredentials({
      ...credentials(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    mock.method(globalThis, "fetch", async (url: URL | string) =>
      String(url).endsWith("/refresh") ? json({}, 503) : json({ ok: true }),
    );
    assert.deepEqual(await new ApiClient().get("/me"), { ok: true });
  });

  it("does not repeat an ambiguous refresh after the old token receives a 401", async () => {
    saveCredentials({
      ...credentials(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    let refreshes = 0;
    mock.method(globalThis, "fetch", async (url: URL | string) => {
      if (String(url).endsWith("/refresh")) {
        refreshes++;
        throw new Error("response lost");
      }
      return json({}, 401);
    });
    await assert.rejects(new ApiClient().get("/me"));
    assert.equal(refreshes, 1);
  });

  it("never retries a second 401 or turns a permission denial into a refresh", async () => {
    saveCredentials(credentials());
    let refreshes = 0;
    mock.method(globalThis, "fetch", async (url: URL | string) => {
      if (String(url).endsWith("/refresh")) {
        refreshes++;
        return json(tokens());
      }
      return json({}, 401);
    });
    await assert.rejects(new ApiClient().get("/me"));
    assert.equal(refreshes, 1);
    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => json({}, 403));
    await assert.rejects(new ApiClient().get("/me"));
    assert.equal(refreshes, 1);
  });

  it("does not silently switch an in-flight command to another login", async () => {
    saveCredentials({ ...credentials(), sessionId: "first" });
    const client = new ApiClient();
    saveCredentials({
      ...credentials(),
      sessionId: "second",
      accessToken: "gauge_cli_other",
    });
    const fetchMock = mock.method(globalThis, "fetch", async () => json({}));
    await assert.rejects(client.get("/me"), /Login changed/);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("rejects host overrides before sending shared credentials", () => {
    saveCredentials(credentials());
    assert.throws(
      () => new ApiClient({ baseUrl: "https://unexpected.test" }),
      /not authorized/,
    );
  });

  it("revokes the stored grant on logout and preserves environment credentials", async () => {
    saveCredentials(credentials());
    process.env.GAUGE_API_TOKEN = "gauge_env";
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      assert.equal(url, "https://chat.test/api/cli/revoke");
      assert.deepEqual(JSON.parse(init.body as string), {
        refreshToken: "gauge_refresh_old",
      });
      return new Response(null, { status: 204 });
    });
    await logout();
    assert.equal(readCredentials(), null);
    assert.equal(resolveToken(), "gauge_env");
  });

  it("clears local credentials and warns when logout cannot revoke remotely", async () => {
    saveCredentials(credentials());
    const warnings: string[] = [];
    mock.method(console, "error", (message: string) => warnings.push(message));
    mock.method(globalThis, "fetch", async () => {
      throw new Error("offline");
    });
    await logout();
    assert.equal(readCredentials(), null);
    assert.match(warnings[0], /server grant may remain active/);
  });
});
