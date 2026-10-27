# Changelog

## Unreleased

- A session spec can include a `gateway` with a web fixture. The session then
  starts a gateway container that serves fixture pages and routes origins over
  intercepted HTTPS. The agent container shares the gateway's network and
  trusts a per-session CA; its image needs no changes.
- The detached session worker now creates and removes the agent container
  (and gateway, when used), instead of `startSession`. Cancelling during
  startup waits for it to stop before cleaning up, and a session whose cleanup
  fails keeps `cleanupPending` so `stopSession` can retry it.

## 0.2.0 — 2026-10-21

- Cancelling a session that is already shutting down is accepted and waits for
  it to finish, instead of failing with `session is closing`. Concurrent
  cancellations, such as `gauge run cancel --batch` racing the detached batch's
  own cancellation, no longer report stopped runs as pending.

- A session that fails because the agent exits names the agent's last stderr
  line: `agent connection exited (1): <line>`.

- Authenticate Codex's app-server with the mounted OpenAI API key before starting
  a local session.

- Depend on agent-adapters 0.2.1, which adds Antigravity stream decoding and
  completes turns that report a recovered API error.

- Accept `workspace: null` to start the agent in an empty Git repository.
- Claude Code `access_token` auth reuses the host's Claude Code login (macOS
  Keychain, else `~/.claude/.credentials.json`). Only the access token is sent.
- Claude Code `setup_token` auth reads only `CLAUDE_CODE_OAUTH_TOKEN`.

## 0.1.0 — 2026-10-15

- Run Claude Code, Codex, Pi, or OpenCode in one local Docker container across
  turns, controlled by a detached host process.
- Provide session start, status, prompt, native question response, finish,
  cancellation, and NDJSON evidence APIs.
- Resolve credentials on the host and stage prepared files, skills, and npm
  packages without embedding a Gauge coordinator in the image.
- Preserve evidence and working files after interruptions; distinguish uncertain
  communication from a lost driver and avoid automatic prompt replay.
- Ship ESM, TypeScript declarations, a stock-harness Dockerfile, README, and MIT
  license. Linux is validated; automatic credential renewal and durable driver
  recovery are not included.
