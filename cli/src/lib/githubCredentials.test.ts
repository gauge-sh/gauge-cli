import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { githubCredentialsPath, resolveGithubToken, saveGithubToken } from "./githubCredentials";
import { saveToken, resolveToken } from "./credentials";

test("GitHub credentials persist separately and only the Gauge-specific environment variable overrides them", () => {
  const previous = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "gauge-github-"));
  try {
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.GAUGE_GITHUB_TOKEN;
    delete process.env.GAUGE_API_TOKEN;
    process.env.GH_TOKEN = "unrelated-gh-token";
    process.env.GITHUB_TOKEN = "unrelated-github-token";
    assert.equal(resolveGithubToken(), null);
    saveToken("gauge-test-token");
    saveGithubToken("  github-test-token\n");
    assert.equal(resolveGithubToken(), "github-test-token");
    assert.equal(readFileSync(githubCredentialsPath(), "utf8"), "github-test-token\n");
    assert.equal(resolveToken(), "gauge-test-token");
    process.env.GAUGE_GITHUB_TOKEN = " override-token ";
    assert.equal(resolveGithubToken(), "override-token");
    process.env.GAUGE_GITHUB_TOKEN = " ";
    assert.equal(resolveGithubToken(), "github-test-token");
    assert.throws(() => saveGithubToken(""));
    assert.throws(() => saveGithubToken("two tokens"));
    assert.equal(resolveGithubToken(), "github-test-token");
  } finally {
    process.env = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
