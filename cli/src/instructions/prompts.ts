export const PROMPTS = `---
name: gauge-prompts
description: Design realistic Agent Preference prompts and Agent Experience tasks
  with independent, observable judging criteria. Read before drafting measurements.
---

# Design prompts that measure useful behavior

## Start with the question

Inspect the product, its docs, existing measurements, and the user's goal before drafting. Map product areas to real use cases and relevant alternatives; do not invent requirements to make a favored product win. Reuse existing measurements when rerunning the same question. Use descriptive task names and tags for product areas or cohorts, without creating a market for every use case.

- **Agent Preference:** which product does the agent recommend for a particular job, and why? Define the decision being measured; a database choice is different from an authentication choice.
- **Agent Experience:** can the agent accomplish a useful task with the product, and where does it struggle? This includes installation, integration, migration, research, and understanding pricing. A passing session can still reveal friction.
- Keep selection and implementation in separate prompts by default. A recommendation does not demonstrate successful use; implementing a required product does not demonstrate organic preference.

## Write like the user

Use a short, natural first-person request, usually one to three sentences. State the job, necessary context, and desired result. Preserve real user constraints; leave discovery and implementation decisions to the evaluated agent. Read the prompt alone: would someone actually ask this?

Put repository revisions, credentials, connections, runtime setup, and budgets in supported configuration or fixtures. The evaluated agent and judge do not share this conversation. Every referenced app, file, or record must be available to the session; resolve draft placeholders before launch. Use meaningful fixture entities instead of artificial rules such as "the first company alphabetically."

Do not add API names, commands, filenames, exact methods, discovery steps, or exhaustive verification instructions just because you know the solution. If the user requests a specific surface, preserve it; otherwise let the agent choose how to use the product. Research docs to establish feasibility and correct criteria, not to turn the prompt into a tutorial.

## Agent Preference

- For a new baseline, cover unbranded open-ended discovery and relevant head-to-head comparisons. Keep the same use case across comparisons; avoid arbitrary checklists or constraints chosen to favor one vendor.
- By default, explicitly ask the agent to **research** and make one clear recommendation, then stop before changing code. This measures researched preference. If the goal is unaided choice, omit the research instruction deliberately and label the difference; do not silently change an existing baseline.
- Open-ended discovery should not name the target brand or smuggle it in through a unique feature description. A head-to-head names both products in the task as well as configuration. Mark intentionally branded open-ended prompts as branded. A named comparison measures choice among supplied options, not discovery.
- Example, open-ended: "I want a hosted documentation site for this project. Research the options and recommend one. Don't build anything yet." Use only with a supplied project fixture.
- Example, head-to-head: "I need a hosted documentation site for this project. Research Product A and Product B and recommend one for us. Don't build anything yet." Replace placeholders with actual alternatives before saving.
- Let a pinned fixture establish the existing stack. For hosted personas, give realistic context and priorities, answer only from those facts, and avoid naming or endorsing a vendor. Keep a recommendation-only persona from authorizing implementation. Personas and attached skills are experimental conditions; distinguish them from the unassisted baseline.

## Agent Experience and criteria

- Test one meaningful outcome, with the minimum verification needed to demonstrate it. Keep a coherent migration intact when it serves the goal. Split independent outcomes; do not turn a basic onboarding task into full CRUD, authentication, security testing, restart testing, and production readiness.
- Use a fresh workspace for installation tests and a verified, independent fixture for later tasks. Official samples test onboarding but may already solve the integration decisions you want to observe. Attach required credentials through supported connections; missing access is a readiness issue.
- Example task: "Use Acme to find the founders of Example Company and their work email addresses." Use verified fixture entities. Let the agent discover the people and supported product interface instead of supplying names and API calls.
- Write a small set of standalone criteria describing observable success and acceptable evidence. Each must follow from the task or existing application's behavior. The judge cannot use this chat, authoring notes, or an unexplained reference answer.
- For the enrichment task, assess correct identification of founders, supported work email results, and explicit reporting of unavailable or unverified results. Do not require a particular endpoint or search sequence. Supply verified reference facts when correctness depends on them.
- For factual tasks such as pricing, state the verified expected facts and applicable conditions in the rubric. Do not use vague "correct pricing" or rely on "the reference checked earlier." Decide whether the benchmark pins dated facts or evaluates current sources, and keep comparisons consistent.
- Review prompt and rubric together. Removing an overprescriptive step also removes it as a hidden grading requirement. Equivalent supported approaches count; unsupported claims, missing evidence, environment failures, and demonstrated errors are different outcomes.

## Pilot, inspect, improve

Show the proposed prompts, starting states, criteria or preference decisions, targets, and session count before launch. Carry forward existing authorization; creating definitions alone does not authorize paid runs. Inspect a small pilot before scaling. If sessions time out or spend too long testing, read traces and narrow incidental work or repair fixtures before increasing budgets.

Read \`gauge instructions session-analysis\` for findings and evidence. Report friction, objections, and actionable opportunities, including recovered friction in successful sessions. Verify product claims against the relevant surface before proposing changes. Tie improvements to pages, skills, CLI behavior, or product issues agents actually encountered. Rerun comparable measurements and report counts and limitations; small pilots and forked interventions do not establish a general win rate.
`;
