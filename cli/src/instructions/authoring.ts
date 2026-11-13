export const AUTHORING = `- Measure one meaningful developer outcome and the friction encountered along the way, including in successful sessions. Inspect the product, existing measurements, and the user's goal first. Record the learning goal, reproducible starting state, observable finish line, and execution budget. Count verification as work: do not expand basic onboarding into full CRUD, authentication, exhaustive tests, and production readiness. Keep a coherent migration intact when it serves the goal; split independent outcomes. Use fresh workspaces for installation and verified, independent fixtures for later tasks. Official samples may already solve the integration decisions you want to observe. Pilot before scaling; inspect costly or timed-out sessions before adding budget.
- Write the prompt as a real user's request, in their language, usually one to three first-person sentences. Describe their goal, relevant context, and intended outcome. Preserve constraints they actually supplied; do not assume technical expertise or invent features, UI actions, business rules, commands, filenames, or verification recipes. Leave discovery and implementation choices to the agent. Research docs to establish feasibility, not to supply the solution. Keep credentials and runtime setup in supported configuration or fixtures; resolve missing access before launch. For example: "I want to use Acme to find the founders of Example Company and their work email addresses." Replace placeholders with real task entities; let the agent discover the people and product interface. Name measurements after the task, without labels such as "credential-free" or "dogfood."
- Align a small set of independently assessable criteria with the requested outcome and existing application. The judge does not share this conversation: state concrete expected behavior, acceptable evidence, and necessary verified reference facts. For the enrichment task, assess correct founders and supported email results, with unavailable results identified; do not require a particular endpoint or search sequence. For factual tasks such as pricing, specify expected facts and conditions rather than "correct pricing" or an unexplained reference answer; distinguish dated facts from current-source checks. Accept equivalent supported approaches and execution evidence; remove hidden requirements when revising the prompt. Distinguish demonstrated errors, missing evidence, environment failures, and budget exhaustion.`;

export const MIGRATION_EXAMPLE = `## Migration prompt and criteria

This example tests migration of an existing feature-flag application across browser and server workflows. Its starting repository contains the application, while attached connections supply destination credentials. The source account's targeting configuration is unavailable.

### Keep the substantial task

A bad version of this migration prompt would add specific features, such as a flag selector, an account switcher, or an activity log. It might also specify exact UI layouts, clicks to perform, SDK calls, or files to edit. Those directions assume the user already knows the implementation and add requirements beyond their goal.

Use the kind of language a user would naturally use to ask for a change. For example, "Let me pass a feature to the CLI and get instructions for it" describes the desired behavior without prescribing command registration or rendering code. Keep details the user actually requests; do not add exact specifications or UI/UX actions just to make grading easier.

> Migrate this app from its current feature-flag provider to the replacement provider while preserving its existing functionality. Get it running locally, verify the migration works, and explain any limitations.

If the user also asks for a complete replacement, carry that decision into the rubric. Do not add backward compatibility or a gradual production rollout solely because a migration guide recommends them.

### Define observable success

Inspect the starting application and relevant migration guidance before drafting criteria. For this application, success means existing browser and server workflows continue to work through the destination provider, live evaluations drive the running UI, and active dependencies on the source provider are removed when full replacement is requested. The rubric can assess behavior present in the source without dictating SDK methods, edited files, or an exact test sequence.

Suitable criteria for this fixture:

- **Complete migration:** Required flags and code references are accounted for. The active integration uses the destination provider, and the app no longer needs the source provider at runtime when full replacement is requested. A separate demo or hardcoded replacement is insufficient.
- **Preserved behavior:** Existing browser/server workflows, context changes, and server-provided initial values continue to work. Available configuration is preserved or differences explained. Exact historical targeting parity cannot be established without source rules.
- **Verified working application:** Execution evidence connects live flag evaluation from the destination provider to the running app's behavior across its browser and server workflows. A build or standalone SDK probe alone does not demonstrate the migration.
- **Appropriate product surfaces:** Supported SDKs/providers fit the browser and server runtimes; supported management interfaces handle configuration; credentials fit each surface. Equivalent approaches are acceptable, and using every tool is unnecessary.

Keep environment identifiers, credential mappings, repository revision, and resource isolation in supported connection or fixture mechanisms where possible. Authoring notes and source limitations must not become an extra implementation checklist.

Missing source rules limit the parity claim. Record that uncertainty and assess observable application behavior; do not replace it with an invented targeting contract. If account-configuration migration is the requested outcome, prepare the required source data before calling the fixture ready.`;
