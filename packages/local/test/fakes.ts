import type { SessionSpec } from "../src/types.js";
export function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agent: { kind: "claude-code", model: "claude-sonnet-5-5" },
    image: "gauge-runtime:test",
    auth: { mode: "setup_token" },
    workspace: { repo: "https://github.com/octocat/Hello-World", ref: "master" },
    resources: [],
    prompt: { text: "Say hello." },
    limits: { turnTimeoutS: 600, responseTimeoutS: null, maxTurns: 5 },
    ...overrides,
  };
}
