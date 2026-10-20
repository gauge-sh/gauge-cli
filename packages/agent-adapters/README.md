# @withgauge/agent-adapters

Portable TypeScript adapters that translate coding agents' native protocols
into consistent events and session state. Supports Claude Code, Codex, Pi,
OpenCode, Cursor, and Antigravity. Requires Node.js 22.12+; ESM; no runtime dependencies.

```sh
npm install @withgauge/agent-adapters
```

```ts
import { NativeSession } from "@withgauge/agent-adapters";

const session = new NativeSession("codex");
const result = session.observe(
  JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 5, output_tokens: 2 },
  }),
  new Date().toISOString(),
);
console.log(result.payloads); // Normalized messages, tools, reasoning, or usage
console.log(result.terminal); // Native turn completion or failure
```

Feed complete native JSON records in order. OpenCode also requires its root
session ID: `new NativeSession("opencode", sessionId)`. Call `beginTurn()` before
sending a follow-up prompt, but not when answering a question within a turn.
Snapshots support `NativeSession.restore()` for trusted state produced by this
API; callers own crash recovery and replay deduplication.

The main entry point also exports `reduceNativeRecord`, types, `PiRpcTransport`,
and `OpenCodeSseTransport`. Import agent-specific decoding helpers from
`@withgauge/agent-adapters/native`. Callers provide process I/O and own agent
launch, authentication, prompts, question answers, storage, and supervision.

### Antigravity

Use `new NativeSession("antigravity")` for `agy` 1.3.5's `--output-format
stream-json` records. The adapter captures conversation identity, tool calls and
results, the assembled final response, and explicit SUCCESS/error completion.
Unknown records remain available in `event.raw` and `event.parsed`. Records with
an explicit different conversation ID produce no evidence or state changes;
create a separate session for each conversation.

Antigravity result usage is **conversation-cumulative**, including after native
process resume. The session emits positive increments against per-counter
high-water marks in `projection.antigravity.cumulativeUsage`. These survive
`beginTurn()` and JSON snapshot restoration. Failed results also contribute
usage; repeated totals contribute none. Missing, non-integer, negative, unsafe,
or regressing counters leave their baseline unchanged. A later valid observation
can recover usage from an earlier incomplete result, so increments need not
belong exclusively to the current turn. Input excludes cache reads; output
already includes thinking. Step usage and `total_tokens` are not added again.

Persist the full snapshot when resuming a native conversation. Constructing a
fresh session with just its ID starts the usage baseline at zero and cannot
distinguish earlier spend from new usage. This is usage deduplication only:
callers still own record replay deduplication for messages, tools, and completion
signals, including late records arriving after `beginTurn()`.

`projection.antigravity.modelSelector` retains `init.model` when supplied. It is
not an observed upstream model, so the adapter does not populate `identity.model`
or `observedModel` from it. Native usage excludes auxiliary search/title calls
and cannot establish total billing. Search/read-URL bodies and final reasoning
are not reliably present; absent tool output stays `null`.

For low-level consumers, `decodeAntigravityEvidence` returns messages and tools
only. Use `reduceAntigravityUsage(parsed, previous)` and persist its returned
`cumulativeUsage`, or use the session reducer to handle both together. This
package supplies no Antigravity process driver, model catalog, or launch policy.

Licensed under the [MIT License](LICENSE).
