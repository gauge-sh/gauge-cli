export const AUTHORING = `- Measure one meaningful developer outcome. Record the learning goal, reproducible starting state, observable finish line, and execution budget; a coherent migration can span browser and server workflows.
- Write the prompt as a real user's request, in their language. Describe their goal, relevant context, and intended outcome. Preserve constraints they actually supplied; do not assume technical expertise or invent features, UI actions, business rules, commands, filenames, or verification recipes. Leave discovery and implementation choices to the agent.
- Align a small set of independently assessable criteria with the requested outcome and existing application. Accept equivalent supported approaches and execution evidence; remove hidden requirements when revising the prompt.`;

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
