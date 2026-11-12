export const CLI_RULES = `---
name: gauge-cli-rules
description: Stub or redirect CLI invocations in a hosted session without changing the fixture repository.
---

# Test proposed CLI commands

Use \`gauge run --hosted --cli-rules rules.json\` with a prompt, \`--eval\`,
\`--preference\`, or case files/specs. Rules apply only to this launch and leave
the fixture repository unchanged. The target CLI must be installed in the session.
Start with this rules.json, replacing the package/program with your CLI:

    {
      "schemaVersion": 4,
      "target": { "kind": "npmBin", "packageName": "@example/cli", "program": "example" },
      "shippingIntent": "interaction",
      "rules": [{
        "id": "create-token",
        "selector": { "kind": "prefix", "argv": ["token", "create"] },
        "operations": [{ "id": "fake-token", "kind": "stub",
          "stdout": "test-token-not-a-real-credential\\n", "stderr": "", "exitCode": 0 }]
      }]
    }

This stubs \`example token create\`: it skips the command and returns the fake
token, including calls with trailing arguments such as \`example token create --output json\`.
A literal prefix compares leading arguments after the executable without parsing
the tail, so matching needs no optionArity. It does not match leading global
options such as \`example --debug token create\`. Unmatched commands execute normally.
Use \`exact\` when the complete argument list must match. Rules run in order; put
specific help rules such as \`['token','create','--help']\` before the broader prefix.
Use a \`command\` selector with optionArity when matching must depend on flags
or accept options before the subcommand. Argument-edit operations still parse
the full invocation and need declared option arities. Existing rules keep their
meaning until you explicitly change them. Both v3 and v4 support prefix selectors.
For a path target use {"kind":"path","path":"/absolute/path/to/program"}.

To run a replacement command instead, use this operation:
{"id":"replacement","kind":"exec","argv":["/bin/echo","test-token"]}.
Use an absolute executable path in the session and literal arguments, not shell
syntax. A stub or exec must be the only operation in its rule.

To test use, name the command in the task. To test discovery, give only the goal
and make the command discoverable, for example with a second rule stubbing
["--help"]. Rules do not advertise commands automatically. Keep the task small
enough for the fake response to satisfy; fake tokens cannot authenticate to real APIs.

Preview prompt/case launches with \`--dry-run\`; saved eval/preference launches
do not support previews. Pass \`--cli-rules rules.json\` on each launch.
In the session viewer, check CLI rules, command annotations, and the agent's next
actions. For command/output evidence, use
\`gauge run commands <run-id> --hosted\` and \`gauge run trace <run-id> --hosted\`.
Configuring a rule is not proof it fired.
`;
