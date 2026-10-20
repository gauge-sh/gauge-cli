import assert from "node:assert/strict";
import { test } from "node:test";
import { detectAgent, detectSkillAgent } from "./detectAgent";

test("any agent marker means agent, even on a TTY", () => {
  for (const name of [
    "CLAUDECODE",
    "CODEX_SANDBOX",
    "CODEX_THREAD_ID",
    "CODEX_CI",
    "CURSOR_AGENT",
    "GEMINI_CLI",
    "CLINE_ACTIVE",
    "OPENCODE",
    "AI_AGENT",
  ])
    assert.equal(detectAgent({ [name]: "1" }, true), "agent", name);
});

test("an empty marker does not count", () => {
  assert.equal(detectAgent({ CLAUDECODE: "" }, true), "human");
});

test("without markers, a TTY is a human and a pipe is an agent", () => {
  assert.equal(detectAgent({}, true), "human");
  assert.equal(detectAgent({}, false), "agent");
  assert.equal(detectAgent({}, undefined), "agent");
});

test("maps agent markers to skills installer names", () => {
  assert.equal(detectSkillAgent({ CLAUDECODE: "1" }), "claude-code");
  assert.equal(detectSkillAgent({ CODEX_THREAD_ID: "x" }), "codex");
  assert.equal(detectSkillAgent({ AI_AGENT: "1" }), undefined);
  assert.equal(detectSkillAgent({}), undefined);
});
