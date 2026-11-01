export const LIFECYCLE = `---
name: gauge-lifecycle
description: Author setup and cleanup scripts for hosted sessions using the Gauge APIs.
---

# Setup and cleanup scripts (hosted only)

Write ordinary JavaScript or TypeScript files with top-level await. No exported function is required.
The CLI uploads each file's contents, not its path or companion files. Gauge supplies Node.js and the session's installed workspace packages; do not assume arbitrary dependencies exist.
Setup runs after the repository, MCP servers, and Connections are ready, before the coding agent. Cleanup (called teardown in CLI flags) is attempted after execution, cancellation, or partial setup failure when the VM remains usable.

## Author, preview, launch

    gauge run --hosted "<task>" --setup-file ./setup.ts --teardown-file ./cleanup.ts --dry-run
    gauge run --hosted "<task>" --setup-file ./setup.ts --teardown-file ./cleanup.ts

Preview validates syntax and configuration, not imports, types, or remote behavior. It does not execute scripts or launch sessions. Hosted commands contact Gauge; previews are not offline checks. Launch only within the user's authorization; hosted runs consume credits.
For one launch of a saved eval: \`gauge run --hosted --eval <id> --setup-file ./setup.ts\`. Unspecified scripts/timeouts/parameters inherit saved values. Use \`--preference <id>\` for a preference prompt. Saved launches do not support \`--dry-run\`.
To save scripts for future runs: \`gauge eval edit <id> --hosted --setup-file ./setup.ts --teardown-file ./cleanup.ts\`. The same flags work with eval/preference create and edit. These edit saved configuration; run flags do not.
Either script is optional. Defaults: 120 seconds per new script; \`--setup-timeout\` / \`--teardown-timeout\` allow 1–600 seconds. Files must be nonempty UTF-8 and at most 128 KiB.
\`--lifecycle-params '{"fixture":"demo"}'\` replaces the shared nonsecret JSON object (64 KiB max). Existing scripts, timeouts, and parameters are preserved when their flags are omitted.
\`--clear-setup\`, \`--clear-teardown\`, or \`--clear-lifecycle\` remove scripts on saved edits or saved launches; clearing the last script also clears parameters. Hooks are unsupported for local runs, case files, and \`--apply\`.

## Runtime API — no package installation required

    import { run, params, mcp, state, agent, signal } from "@withgauge/session";

| Binding | Use |
|---|---|
| run | Immutable id, attempt, phase (setup/teardown), workspacePath, setupOutcome, executionOutcome. The script runs from workspacePath. |
| params | Immutable shared JSON configuration supplied by --lifecycle-params. |
| mcp.connect(name) | Connect to an attached server by its exact handle, without @label; configured authentication is provided. Returns a client with listTools(), callTool({name, arguments}), and close(). |
| state.set(key, json), state.get(key), state.delete(key) | Await all calls. Durable JSON within one session attempt, shared by setup and cleanup. get returns undefined when absent. |
| agent.setEnv(key, value) | Await to pass a nonsecret string to the coding agent. Setup only. |
| signal | AbortSignal for cancellation and the phase deadline; signal.throwIfAborted() checks it. |

Setup example: \`await state.set("resourceId", "created-id"); await agent.setEnv("TEST_RESOURCE_ID", "created-id");\`
Cleanup example: \`const id = await state.get("resourceId");\` — handle missing state, restore/remove the resource, then \`await state.delete("resourceId");\`.
For MCP: \`const client = await mcp.connect("your-server"); const { tools } = await client.listTools();\` Inspect actual tool schemas; do not invent names or arguments. Check \`result.isError\` after callTool and throw on failure.
Throw or exit nonzero to fail. console.log provides phase progress. Keep credentials out of source, params, state, agent environment exports, and logs; use configured Connections for authentication.
Scripts do not serialize sessions or isolate shared remote state. Prefer disposable per-session fixtures. Save cleanup identifiers early, tolerate partial setup, and make cleanup safe to repeat. Cleanup is best effort if the VM is lost.
Use \`gauge run watch <run-id>\` to follow execution and \`gauge run --help\` for launch flags. Drafting a script or reading these instructions does not start a session.
`;
