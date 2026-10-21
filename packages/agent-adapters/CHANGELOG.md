# Changelog

## Unreleased

## 0.2.1 — 2026-10-21

- Antigravity: a `result` with status `ERROR` now completes the turn and keeps
  the error as its terminal reason. agy reports ERROR even after its own retry
  recovers (exit 0, full response); the process exit code (3) is the failure
  signal.

## 0.2.0 — 2026-10-16

- Add Antigravity 1.3.5 stream decoding, conversation identity, tool evidence,
  final responses, and explicit turn completion/failure.
- Convert cumulative native usage into increments using durable per-counter
  baselines across continuation and snapshot restoration, including failed turns.
- Retain the native model selector separately from observed provider identity.

## 0.1.0 — 2026-10-15

- Decode native Claude Code, Codex, Cursor, Pi, and OpenCode output into common
  message, reasoning, tool, usage, and turn-completion records.
- Track session state and correlations with `NativeSession`, snapshots, and
  the pure `reduceNativeRecord` reducer.
- Provide Pi RPC and OpenCode SSE transports over caller-supplied process I/O.
- Ship ESM and TypeScript declarations with no runtime npm dependencies.
