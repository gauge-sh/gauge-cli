export const CLI_RULES = `---
name: gauge-cli-rules
description: Stub or redirect CLI invocations in a hosted session without changing the fixture repository.
---

# Test proposed CLI commands

Use \`gauge run --hosted --cli-rules rules.json\` with a prompt, \`--eval\`,
\`--preference\`, case files, or \`--apply\` with a case spec. No optimization,
issue, or previous session is needed. The validated rules apply to this launch
only; they do not modify saved settings or the fixture repository. The target
executable must already be available or installed during the session.
Example rules.json for a proposed subcommand of the npm package @example/cli:

    {
      "schemaVersion": 4,
      "target": { "kind": "npmBin", "packageName": "@example/cli", "program": "example" },
      "shippingIntent": "interaction",
      "rules": [{
        "id": "create-token",
        "selector": { "kind": "exact", "argv": ["token", "create"] },
        "operations": [{ "id": "fake-token", "kind": "stub",
          "stdout": "test-token-not-a-real-credential\\n", "stderr": "", "exitCode": 0 }]
      }]
    }

Replace the package/program with the actual CLI. Exact argv excludes the
executable and is order-sensitive. Unmatched commands execute normally.
For a path target use {"kind":"path","path":"/absolute/path/to/program"}.
A command selector matches parsed positionals/options; declare optionArity.
Unknown or ambiguous options can prevent a match.

A stub skips the original command. To redirect it, replace the operation with
{"id":"replacement","kind":"exec","argv":["/bin/echo","test-token"]}.
The first replacement argument must be an absolute executable path in the
session. argv is literal, not shell syntax. A stub or exec must be the only
operation in its rule. Schema v3 still supports argument/environment/stdin/output
edits; replacements require v4. Omit bundleSha256 and limits: Gauge seals them.

Separate use from discovery: name the proposed command in the task to test its
use; to test discovery, state only the goal and expose it in help/docs the agent
can find. A rule does not advertise a command automatically. For example, add
a second exact rule for ["--help"] that mentions token create. Keep the task
bounded to something the fake response can satisfy; fake credentials cannot
authenticate against a real API.
The flag is hosted-only, takes a JSON file (not stdin), and rejects legacy
battery specs and --verify/--schema/--example. Limit: 2 MiB and 50 rules.
Prompt/case previews with --dry-run report rule count and digest; saved hosted
evals/preferences do not support --dry-run. Pass the flag again for each changed
launch. Preview does not reserve bytes; launch reads the file again.

Inspect View CLI rules in the session viewer, then the command annotations and
the agent's next actions. Annotations sit near the recorded event time. Use
\`gauge run commands <run-id> --hosted\` and \`gauge run trace <run-id> --hosted\`
for the command/output evidence. Configuring a rule is not proof it fired.
`;
