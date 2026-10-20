import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialError, resolveSessionCredential } from "../src/credentials.js";
import { spec } from "./fakes.js";

const jwt = (exp: number) =>
  `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

describe("credentials", () => {
  const now = new Date("2026-10-14T00:00:00Z");
  const codexAuth = (exp: number) =>
    JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: "sk-should-be-dropped",
      last_refresh: "2026-10-12T00:00:00Z",
      tokens: { access_token: jwt(exp), id_token: "id", account_id: "acct", refresh_token: "rt-secret" },
    });

  it("delivers the Claude setup-token as a mounted file, never as a value in the script", async () => {
    const cred = await resolveSessionCredential(spec(), { env: { CLAUDE_CODE_OAUTH_TOKEN: "tok" }, homeDir: "/h", now });
    expect(cred.files).toEqual([{ name: "claude-token", contents: "tok", target: "/run/gauge/claude-token", readonly: true }]);
    expect(cred.exports).toEqual(['export CLAUDE_CODE_OAUTH_TOKEN="$(cat /run/gauge/claude-token)"']);
  });

  it("explains a missing setup-token", async () => {
    await expect(resolveSessionCredential(spec(), { env: {}, homeDir: "/h", now })).rejects.toMatchObject({
      remedy: expect.stringContaining("CLAUDE_CODE_OAUTH_TOKEN"),
    });
  });

  describe("the host Claude Code login", () => {
    const login = (expiresIn: number) =>
      JSON.stringify({
        claudeAiOauth: { accessToken: "at", refreshToken: "rt-secret", expiresAt: now.getTime() + expiresIn * 1000 },
      });
    const claude = spec({ auth: { mode: "access_token" } });
    const none = async () => undefined;

    it("sends only the access token, from the Keychain", async () => {
      const cred = await resolveSessionCredential(claude, { env: {}, homeDir: "/h", now, readKeychain: async () => login(8 * 3600) });
      expect(cred.files).toEqual([{ name: "claude-token", contents: "at", target: "/run/gauge/claude-token", readonly: true }]);
      expect(JSON.stringify(cred)).not.toContain("rt-secret");
      expect(cred.expiresAt).toEqual(new Date(now.getTime() + 8 * 3600 * 1000));
    });

    it("falls back to ~/.claude/.credentials.json", async () => {
      const read = async (p: string) => (p === "/h/.claude/.credentials.json" ? login(8 * 3600) : undefined);
      const cred = await resolveSessionCredential(claude, { env: {}, homeDir: "/h", now, readKeychain: none, readFile: read });
      expect(cred.files[0]!.contents).toBe("at");
    });

    it("rejects a login that expires before the turn ends, or no login", async () => {
      await expect(
        resolveSessionCredential(claude, { env: {}, homeDir: "/h", now, readKeychain: async () => login(600) }),
      ).rejects.toMatchObject({ remedy: expect.stringContaining("claude -p ok") });
      await expect(
        resolveSessionCredential(claude, { env: {}, homeDir: "/h", now, readKeychain: none, readFile: none }),
      ).rejects.toMatchObject({ message: expect.stringContaining("No Claude Code login") });
    });
  });

  it("strips the Codex refresh token and ambient API key", async () => {
    const exp = now.getTime() / 1000 + 5 * 86400;
    const cred = await resolveSessionCredential(spec({ agent: { kind: "codex", model: "gpt-6-astra" }, auth: { mode: "access_token" } }), {
      env: {},
      homeDir: "/h",
      now,
      readFile: async (p) => (p === "/h/.codex/auth.json" ? codexAuth(exp) : undefined),
    });
    const written = JSON.parse(cred.files[0]!.contents);
    expect(written.tokens).toEqual({ access_token: jwt(exp), id_token: "id", account_id: "acct", refresh_token: "" });
    expect(written.OPENAI_API_KEY).toBeNull();
    expect(cred.files[0]!.contents).not.toContain("rt-secret");
    expect(cred.files[0]!.target).toBe("/run/gauge/codex-auth.json");
    expect(cred.files[0]!.readonly).toBe(true);
  });

  it("logs Codex in with its mounted API key before starting app-server", async () => {
    const cred = await resolveSessionCredential(
      spec({ agent: { kind: "codex", model: "gpt-6.1-sol" }, auth: { mode: "api_key" } }),
      { env: { OPENAI_API_KEY: "test-openai-secret" }, homeDir: "/h", now },
    );
    expect(cred.files).toEqual([
      { name: "openai-api-key", contents: "test-openai-secret", target: "/run/gauge/openai-api-key", readonly: true },
    ]);
    expect(cred.exports).toContain("codex login --with-api-key < /run/gauge/openai-api-key");
    expect(cred.exports.join("\n")).not.toContain("test-openai-secret");
    await expect(
      resolveSessionCredential(
        spec({ agent: { kind: "codex", model: "gpt-6.1-sol" }, auth: { mode: "api_key" } }),
        { env: {}, homeDir: "/h", now },
      ),
    ).rejects.toThrow(/OPENAI_API_KEY/);
  });

  it("redacts malformed native Codex login contents", async () => {
    const result = resolveSessionCredential(spec({ agent: { kind: "codex", model: "m" }, auth: { mode: "access_token" } }), {
      env: {}, homeDir: "/h", now, readFile: async () => "{secret-token-fragment}",
    });
    await expect(result).rejects.toMatchObject({ message: "The native Codex login file is invalid.", remedy: expect.stringContaining("codex login") });
  });

  it("gives OpenCode and Pi the ChatGPT access token without its refresh token", async () => {
    const exp = now.getTime() / 1000 + 5 * 86400;
    const src = { env: {}, homeDir: "/h", now, readFile: async () => codexAuth(exp) };
    const oc = await resolveSessionCredential(
      spec({ agent: { kind: "opencode", model: "openai/gpt-6-astra" }, auth: { mode: "access_token" } }),
      src,
    );
    expect(JSON.parse(oc.files[0]!.contents)).toEqual({
      openai: { type: "oauth", access: jwt(exp), refresh: "", expires: exp * 1000, accountId: "acct" },
    });
    expect(oc.exports).toEqual(['export OPENCODE_AUTH_CONTENT="$(cat /run/gauge/opencode-auth.json)"']);

    const pi = await resolveSessionCredential(
      spec({ agent: { kind: "pi", model: "openai-codex/gpt-6-astra" }, auth: { mode: "access_token" } }),
      src,
    );
    expect(JSON.parse(pi.files[0]!.contents)["openai-codex"].refresh).toBe("");
    expect(pi.exports).toContain("cp /run/gauge/pi-auth.json /tmp/pi-agent/auth.json");
    for (const cred of [oc, pi]) expect(cred.files[0]!.contents).not.toContain("rt-secret");
  });

  it("rejects subscription routes that are not allowed", async () => {
    const src = { env: {}, homeDir: "/h", now, readFile: async () => codexAuth(now.getTime() / 1000 + 86400 * 5) };
    for (const kind of ["opencode", "pi"] as const)
      await expect(
        resolveSessionCredential(spec({ agent: { kind, model: "anthropic/claude-x" }, auth: { mode: "setup_token" } }), src),
      ).rejects.toThrow(/only in Claude Code/);
    await expect(
      resolveSessionCredential(spec({ agent: { kind: "opencode", model: "anthropic/claude-x" }, auth: { mode: "access_token" } }), src),
    ).rejects.toThrow(/only openai/);
  });

  it("takes API keys only from the provider's explicitly exported variable", async () => {
    const pi = spec({ agent: { kind: "pi", model: "fireworks/accounts/fireworks/models/x" }, auth: { mode: "api_key" } });
    const cred = await resolveSessionCredential(pi, { env: { FIREWORKS_API_KEY: "fw" }, homeDir: "/h", now });
    expect(cred.exports.at(-1)).toBe('export FIREWORKS_API_KEY="$(cat /run/gauge/fireworks-api-key)"');
    await expect(resolveSessionCredential(pi, { env: {}, homeDir: "/h", now })).rejects.toThrow(/FIREWORKS_API_KEY/);
  });

  it("refuses a Codex token that would expire during the turn", async () => {
    const exp = now.getTime() / 1000 + 600;
    await expect(
      resolveSessionCredential(spec({ agent: { kind: "codex", model: "m" }, auth: { mode: "access_token" } }), {
        env: {},
        homeDir: "/h",
        now,
        readFile: async () => codexAuth(exp),
      }),
    ).rejects.toMatchObject({ remedy: expect.stringContaining("codex") });
  });
});
