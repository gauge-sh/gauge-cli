export const HILLCLIMB = `---
name: gauge-hillclimb
description: Plan and carry out an evidence-driven improvement loop for a product,
  CLI, SDK, Skill, or documentation. Use for open-ended setup and usability testing.
---

# Hillclimb: improve a product with agent sessions

For open-ended requests, inspect the project and propose a small pilot; infer what you can from the goal and files.
Ask only for decisions that affect the test. For narrow requests, use just the relevant part of this loop.

1. **Identify the product and learning goal.** Inspect existing measurements, gauge.json,
   build outputs, docs, and agent guidance. Separate the product being tested from the
   consumer workspace. Use evals for successful use or preference measurements for
   selection and rejection. Name the input and what the session can establish.
2. **Choose representative tasks and a backend.** Cover first use, a common task,
   and a plausible mistake or unsupported request. Expected rejection with useful recovery
   can be success. Use realistic prompts and observable outcomes without hidden rubric
   requirements. Honor requested models and state cases × targets × samples.
3. **Prepare and run a small baseline.** Preserve supplied product/docs content during setup;
   propose fixes separately. Save groups with eval/preference or shared cases for automation. Build/pack,
   verify cases, then preview selected files and runtime readiness. Preview is not execution.
   Use existing authorization for the agreed scope and budget; otherwise ask before
   launching sessions. A blocked prerequisite is a setup result, not a product failure.
4. **Extract evidence and publish analysis.** Read transcripts and artifacts, not only
   grades. Distinguish product friction, agent mistakes, environment failures, and missing
   evidence. Locally your coding agent publishes structured analysis; hosted runs provide
   analysis to inspect. Use \`gauge instructions session-analysis\`. Query current findings
   with distinct affected-session counts and analysis coverage; keep clean sessions visible.
5. **Make a focused change and rerun.** Turn supported findings into a small hypothesis,
   implement within the user's scope, rebuild/repack, and rerun the affected measurements.
   Keep tasks, criteria, model pins, and other fixtures fixed where possible. Identify the
   intended input change; disclose rubric corrections and other changes that limit comparison.
6. **Compare and decide.** After runs and analysis settle, use \`gauge run compare\`
   with baseline/candidate batch selectors locally or request/batch selectors hosted.
   Inspect whether the original friction disappeared and whether new friction appeared.
   Repeat inconclusive tests within budget; stop at the budget, an unresolved prerequisite,
   or a useful review point. Report sample sizes, before/after evidence, and limits.

## Hosted boundaries and next steps

Website inputs route a canonical HTTPS origin to a public docs preview in hosted
execution. Local runs do not provide that routing, and \`--input\` cannot turn a
website declaration into a local directory or preview URL. Read \`gauge instructions run --hosted\` for supported preview sources.
For a local content-only test, attach docs with a \`files\` input or put a reachable preview URL in the prompt.
Confirm the preview contains the edits and is reachable inside Docker; the host's localhost may not be.
Supplied files or a direct URL test use of supplied content, not canonical docs discovery.
Never silently substitute that test for discovery or call a live site's unchanged docs a local edit.

Gauge exposes no local MCP configuration for registered servers; files cannot test live tool discovery or calls.
At a hosted-only boundary, explain the blocked capability and what hosted enables; preserve the user's task.
Offer a concrete next step: \`gauge onboard\`, workspace selection, then MCP version/connection or website setup.
Verify access and reachability before claiming readiness; login and static verification do not establish either.
When offering hosted, tell the user sessions use credits and even a preview contacts Gauge and may upload inputs.
For local-only requests, explain hosted options without issuing hosted commands or changing backends.
Reuse authorization for agreed setup; do not ask permission at every step. See \`gauge instructions run\` for case mechanics.
`;
