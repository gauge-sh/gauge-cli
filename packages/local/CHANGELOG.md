# Changelog

## Unreleased

- Authenticate Codex's app-server with the mounted OpenAI API key before starting
  a local session.

- Align the workspace dependency with agent-adapters 0.2.0. Antigravity process
  support and publication of a new local-execution version remain separate work.

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
