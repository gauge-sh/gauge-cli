# @withgauge/local-execution

Operate Claude Code, Codex, Pi, or OpenCode in one local Docker container for the
entire session. The image contains stock harnesses and standard tools; Gauge's
connection handling, conversation inputs, evidence, and lifecycle state stay on
the host.

`startSession` creates a detached host process that owns the harness connection.
The calling CLI can exit; later commands reach the same process through a private
Unix socket. It clones the public GitHub repository (or starts an empty one when
`workspace` is `null`), runs the initial prompt,
keeps the harness available for further prompts or question answers, and captures
a diff before stopping. Status reads only observe the session.

## Installation

```sh
npm install @withgauge/local-execution@0.1.0
docker pull ghcr.io/gauge-sh/gauge-runtime:0.1.0
```

The package also includes the Dockerfile for building a custom runtime.

## API

```ts
import {
  startSession, getSessionStatus, sendPrompt, finishSession,
} from "@withgauge/local-execution";
import { homedir } from "node:os";

const directory = "/absolute/path/.gauge/sessions/example";
await startSession({
  directory, // must be new
  credentials: { env: process.env, homeDir: homedir() },
  spec: {
    image: "ghcr.io/gauge-sh/gauge-runtime:0.1.0",
    agent: { kind: "codex", model: "gpt-6-astra" },
    auth: { mode: "access_token" },
    workspace: { repo: "https://github.com/octocat/Hello-World", ref: "master" },
    resources: [],
    prompt: { text: "Describe this repository." },
    limits: { turnTimeoutS: 600, responseTimeoutS: null, maxTurns: 5 },
  },
});

// In a later invocation, after the initial turn completes:
const status = await getSessionStatus(directory);
if (status.state === "waiting") {
  await sendPrompt(directory, status.turn, "Suggest one improvement.");
  // Or finishSession(directory) when no more work is needed.
}
```

| Operation | Meaning |
| --- | --- |
| `startSession(options)` | Start one container and its detached host driver; return once the driver is reachable. |
| `getSessionStatus(directory)` | Read preparing/running/waiting/blocked/terminal status. |
| `sendPrompt(directory, expectedTurn, text)` | Continue the same harness; reject stale or concurrent sends. |
| `answerQuestion(directory, questionId, answer)` | Deliver a native harness response to a pending request. |
| `finishSession(directory)` | Finish an idle session, capture its diff, and clean up. |
| `stopSession(directory)` | Cancel active work or explicitly clean up an interrupted session. |
| `readSessionEventsNdjson(directory)` | Read normalized NDJSON evidence. |

`status.question.request` contains the complete native request envelope, including
its method or type. `answerQuestion` takes the response payload, not an envelope;
the driver supplies the request ID and transport framing.

| Harness request | Answer payload |
| --- | --- |
| Codex `method: "item/tool/requestUserInput"`; questions in `params.questions` | `{ answers: { questionId: { answers: ["choice"] } } }` |
| Codex `method: "item/commandExecution/requestApproval"` or `"item/fileChange/requestApproval"` | `{ decision: "accept" }` or `{ decision: "decline" }` |
| Claude `type: "control_request"`; details in `request` | `{ behavior: "allow", updatedInput: ... }` or `{ behavior: "deny", message: "reason" }` |
| Pi `type: "extension_ui_request"`; `method` identifies the UI operation | `{ value: "choice" }`, `{ confirmed: true }`, or `{ cancelled: true }`, as appropriate |
| OpenCode `type: "question.asked"`; questions in `properties.questions` | An array of answer arrays, such as `[["choice"]]` |

For other native methods, consult that harness's protocol before answering; do not
guess a response. The supervising agent chooses the answer or asks the user; the
driver supplies no policy.

`answerQuestion` and `finishSession` accept an optional expected turn as their
last argument, so a supervisor can reject stale requests inside the driver.
`SessionNotFoundError` identifies an absent session without inspecting private
launch files. Status includes `workspaceCommit` once preparation finishes.

Resources may be raw files or host-prepared archives. Archive `use` selects
plain files, a skill directory, or a packed npm package installed into the
environment or workspace. Callers must prepare archives without links or
special files. The CLI supplies this packaging; the executor verifies digests,
extracts the archive, and stages it using the stock harness's directories/tools.

## Boundaries and failure behavior

- Requires Node 22.13+, a Unix host, and local Docker running Linux containers
  (`linux/amd64` or `linux/arm64`). Docker Desktop on macOS supplies the Linux
  daemon and host file sharing; the host itself does not need to run Linux.
  Remote Docker contexts cannot mount the local session files. Use WSL on Windows.
- One container and one stock harness process survive across prompts. Claude uses
  streaming stdin, Codex its app server, Pi RPC, and OpenCode its local HTTP/SSE
  server. OpenCode is reached through `docker exec`; no host port is published.
- Only the disposable workspace, frozen inputs, and selected credential files
  are mounted. The host socket, inputs journal, status, and evidence are not
  mounted into the workload. This is not a tamper-proof attestation of agent output.
- Credentials are resolved on the host, mounted privately, and excluded from
  Docker arguments/environment. Refresh tokens are stripped. Expiring logins
  must outlive each new turn; the driver stops before expiry and asks for host
  renewal. It does not conduct login flows or automatically renew credentials.
- If the host driver exits and its socket is unavailable, status becomes `interrupted`. `stopSession` cleans
  up after stopping the container and preserving its repository in
  `recovered-workspace/`, reported as `status.artifacts.workspace`. Existing
  evidence remains available; output emitted after the driver died is not recovered.
  There is no automatic reconnect, prompt replay, or container restart.
  Timeouts, invalid replies, and disconnects with an unconfirmed owner raise
  `SessionUnavailableError`: the driver may still be running, and a command may
  already have been delivered. Check status before acting. Cancellation timeout
  leaves cleanup with the driver; it never starts competing cleanup. Orphan
  cleanup requires the recorded driver PID to have exited. If its PID has been
  reused, cleanup conservatively refuses to proceed.
- `finishSession` acknowledges the request; wait for terminal status to obtain
  results. Cancellation captures a best-effort partial diff; active writes may
  race that capture. Completed idle sessions have a stable final diff.
  If diff capture fails, cleanup preserves the repository instead. Preservation
  excludes the sibling harness home and credential files; repository contents
  remain untrusted workload output. If preservation fails, cleanup throws or
  reports failure and retains the runtime directory for another cleanup attempt.
  A terminal status with `cleanupPending: true` needs `stopSession` again after
  the driver exits; ordinary terminal sessions need no further cleanup.
- `session.json` is a generated host-only launch record, not user-authored config.
  The host also retains `status.json`, `inputs.ndjson`, raw `agent.ndjson`,
  normalized `events.ndjson`, diagnostics, and `diff.patch` when capture succeeds.
- The CLI owns workspace configuration and SQLite product state; this execution
  package writes durable evidence files. It does not index transcripts or publish
  analysis. Image publishing and transparent recovery across driver crashes are
  outside this package's scope.

## Development

From the workspace root:

```sh
npm run check
docker build -t gauge-runtime:dev packages/local/image
# Deterministic lifecycle tests, no inference credentials:
docker build -t gauge-session-fixture:test packages/local/test/runtime-fixture
GAUGE_DOCKER_FIXTURES=1 npm exec -- vitest run packages/local/test/lifecycle.it.test.ts
# Live sessions: Anthropic API key for Claude; host Codex login for the others:
GAUGE_DOCKER_TESTS=1 GAUGE_IT_CHATGPT=1 npm run test:docker -w @withgauge/local-execution
```

Use `GAUGE_IT_AGENTS=codex,pi` to select live cases. The stock image pins harness
versions independently of the host package. A compatible custom image can later
implement the same tool/path contract without embedding Gauge code.
