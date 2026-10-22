import { createHash } from "node:crypto";
import childProcess, { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { Command } from "commander";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
import {
  DEFAULT_AUTH_URL,
  refreshCredentials,
  resolveAuthUrl,
  sharedTokenSchema,
} from "./sharedAuth";
import { updateConfig } from "./config";
import {
  browserLogin,
  deviceLogin,
  logout,
  parseLoopbackCallback,
  register,
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
    // Browser/device tests must not launch a real browser on the CI runner.
    mock.method(childProcess, "spawn", () =>
      Object.assign(new EventEmitter(), { unref() {} }),
    );
    syncBuiltinESMExports();
  });
  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  });

  it("retains explicit authentication endpoint overrides", () => {
    delete process.env.GAUGE_AUTH_URL;
    assert.equal(resolveAuthUrl(), DEFAULT_AUTH_URL);
    updateConfig({ authUrl: "https://configured.test/" });
    assert.equal(resolveAuthUrl(), "https://configured.test");
    process.env.GAUGE_AUTH_URL = "https://environment.test/";
    assert.equal(resolveAuthUrl(), "https://environment.test");
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

  it("uses Chat device endpoints by default and retains refresh metadata for Chat-only users", async () => {
    delete process.env.GAUGE_AUTH_URL;
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
      `${DEFAULT_AUTH_URL}/api/cli/device/authorize`,
      `${DEFAULT_AUTH_URL}/api/cli/device/token`,
      `${DEFAULT_AUTH_URL}/api/cli/me`,
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

  it("uses Chat browser login by default with PKCE and saves a refreshable session", async () => {
    delete process.env.GAUGE_AUTH_URL;
    const originalFetch = globalThis.fetch;
    let authorize: URL | undefined;
    let callback: Promise<Response> | undefined;
    mock.method(console, "log", (message: string) => {
      const match = message.match(
        /https:\/\/app\.withgauge\.com\/cli\/authorize\?\S+/,
      );
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
        assert.equal(String(url), `${DEFAULT_AUTH_URL}/api/cli/me`);
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

  it("does not replay a lost refresh response across independent processes", async () => {
    let refreshes = 0;
    let apiCalls = 0;
    const server = createServer((req, res) => {
      if (req.url === "/api/cli/refresh") {
        refreshes++;
        assert.equal(
          (readCredentials() as SharedCredentials).refreshPending,
          true,
        );
        req.socket.destroy();
      } else {
        apiCalls++;
        res.end(JSON.stringify({ ok: true }));
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    saveCredentials({
      ...credentials(),
      authUrl: origin,
      apiUrl: origin,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    const script = `import { ApiClient } from './src/lib/client.ts';
      try { await new ApiClient().get('/me'); process.exitCode = 2; }
      catch (e) { console.log(e.message); }`;
    try {
      for (let i = 0; i < 2; i++) {
        const result = await promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              GAUGE_API_URL: origin,
              GAUGE_AUTH_URL: origin,
            },
          },
        );
        assert.match(result.stdout, /outcome is uncertain.*gauge auth login/);
      }
      assert.equal(refreshes, 1);
      assert.equal(apiCalls, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("retains uncertainty when rotated credentials cannot be saved", async () => {
    const original = credentials(true);
    saveCredentials(original);
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      mock.method(fs, "renameSync", () => {
        throw new Error("disk write failed");
      });
      syncBuiltinESMExports();
      return json(tokens());
    });
    try {
      await assert.rejects(
        refreshCredentials(original),
        /outcome is uncertain/,
      );
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(readCredentials(), { ...original, refreshPending: true });
    await assert.rejects(new ApiClient().get("/me"), /gauge auth login/);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  it("does not dispatch refresh when its pending marker cannot be saved", async () => {
    const original = credentials(true);
    saveCredentials(original);
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      json(tokens()),
    );
    mock.method(fs, "renameSync", () => {
      throw new Error("disk write failed");
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(refreshCredentials(original), /disk write failed/);
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
    assert.deepEqual(readCredentials(), original);
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("does not retry refresh after an unreadable successful response", async () => {
    saveCredentials(credentials(true));
    const fetchMock = mock.method(globalThis, "fetch", async () => json({}));
    await assert.rejects(new ApiClient().get("/me"), /outcome is uncertain/);
    await assert.rejects(new ApiClient().get("/me"), /outcome is uncertain/);
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  it("blocks replay after a process dies with the rotation response received", async () => {
    let refreshes = 0;
    const server = createServer((_req, res) => {
      refreshes++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(tokens()));
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
    const script = `import { readCredentials } from './src/lib/credentials.ts';
      import { refreshCredentials } from './src/lib/sharedAuth.ts';
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (...args) => { await realFetch(...args); process.exit(17); };
      await refreshCredentials(readCredentials());`;
    try {
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "-e", script],
          { cwd: process.cwd(), env: process.env },
        ),
        (error: unknown) => (error as { code: number }).code === 17,
      );
      assert.equal(refreshes, 1);
      assert.equal(
        (readCredentials() as SharedCredentials).refreshPending,
        true,
      );
      // Simulate the documented manual removal after confirming process death.
      rmSync(`${credentialsPath()}.lock`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      json(tokens()),
    );
    await assert.rejects(new ApiClient().get("/me"), /outcome is uncertain/);
    assert.equal(fetchMock.mock.callCount(), 0);
    // A fresh login replaces the marker; logout can still use the old secret.
    saveCredentials(credentials());
    await new ApiClient().get("/me");
    assert.equal(fetchMock.mock.callCount(), 1);
  });

  it("imports legacy tokens through Agents without opting into an auth endpoint", async () => {
    delete process.env.GAUGE_AUTH_URL;
    mock.method(console, "log", () => {});
    mock.method(process.stdin, Symbol.asyncIterator, async function* () {
      yield "gauge_legacy_import\n";
    });
    const seen: string[] = [];
    mock.method(
      globalThis,
      "fetch",
      async (url: URL | string, init: RequestInit) => {
        seen.push(String(url));
        assert.equal(
          new Headers(init.headers).get("Authorization"),
          "Bearer gauge_legacy_import",
        );
        return json({
          user: { id: "agents-user", email: "person@test.com" },
          orgs: [],
        });
      },
    );
    const program = new Command();
    register(program);
    await program.parseAsync(["auth", "login", "--with-token"], {
      from: "user",
    });
    assert.equal(readCredentials(), "gauge_legacy_import");
    await new ApiClient().get("/api/v1/me");
    assert.deepEqual(seen, [
      "https://agents.test/api/v1/me",
      "https://agents.test/api/v1/me",
    ]);
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
    await assert.rejects(
      new ApiClient().post("/mutate", {}),
      /outcome is uncertain/,
    );
    assert.deepEqual(readCredentials(), { ...original, refreshPending: true });
    assert.equal(calls, 1);
    saveCredentials(credentials());
    calls = 0;
    await assert.rejects(new ApiClient().post("/mutate", {}), /unavailable/);
    assert.equal(calls, 1);
  });

  it("requires login after an uncertain server error during refresh", async () => {
    saveCredentials(credentials());
    mock.method(globalThis, "fetch", async (url: URL | string) =>
      json({}, String(url).endsWith("/refresh") ? 503 : 401),
    );
    await assert.rejects(new ApiClient().get("/me"), (error: unknown) => {
      assert.equal((error as { code: string }).code, "unauthorized");
      return true;
    });
    assert.equal(resolveToken(), "gauge_cli_old");
  });

  it("keeps using an unexpired access token after a definite rate-limit rejection", async () => {
    saveCredentials({
      ...credentials(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    mock.method(globalThis, "fetch", async (url: URL | string) =>
      String(url).endsWith("/refresh") ? json({}, 429) : json({ ok: true }),
    );
    assert.deepEqual(await new ApiClient().get("/me"), { ok: true });
    assert.equal(
      (readCredentials() as SharedCredentials).refreshPending,
      undefined,
    );
    mock.restoreAll();
    mock.method(globalThis, "fetch", async (url: URL | string) =>
      String(url).endsWith("/refresh") ? json(tokens()) : json({ ok: true }),
    );
    await new ApiClient().get("/me");
    assert.equal(
      (readCredentials() as SharedCredentials).refreshToken,
      "gauge_refresh_new",
    );
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
    saveCredentials({ ...credentials(), refreshPending: true });
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
