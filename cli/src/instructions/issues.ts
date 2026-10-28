export const ISSUES = `---
name: gauge-issues
description: Find the friction agents hit with your product and their
  objections to it, ranked by impact. Read before choosing what to improve.
---

# Issues

An issue is the same finding across many sessions. Each issue is friction,
which agents hit in any session, or an objection, which agents raise when they
pass on your product in a preference session. Findings is an alternative term
for issues. Gauge groups each analyzed run's findings into issues per product.

## Find and read

    gauge issues list -o json                  # every issue, most sessions first
    gauge issues list --type friction -o json  # or --type objection
    gauge issues get <id> -o json         # the issue's findings, runs, and agents
    gauge run insight <run> -o json       # one run's findings with their issue

Friction shows impact by effect: BLOCKED, EXTRA_WORK, RECOVERED, or UNKNOWN.
Objection shows where agents went instead. Some findings are not in an issue
yet; \`issues list\` counts them.

## Choose what to improve

- Rank by sessions and effect. BLOCKED and EXTRA_WORK cost agents the most.
- Read the findings and their evidence before you name a cause.
- Prefer issues on surfaces the org owns: its docs, skills, and CLI.
- Improve an issue with \`gauge optimizations create --issue <id>\`:
  \`gauge instructions optimization\`.
`;
