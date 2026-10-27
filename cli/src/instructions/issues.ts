export const ISSUES = `---
name: gauge-issues
description: Find the problems agents hit with your product and the reasons
  they passed on it, ranked by impact. Read before choosing what to improve.
---

# Issues

An issue is the same finding across many sessions: one problem agents hit, or
one reason they passed on your product. Findings is an alternative term for
issues. Gauge groups each analyzed run's findings into issues per product.

## Find and read

    gauge issues list -o json             # problems from evals, most sessions first
    gauge issues list --reasons -o json   # why agents passed on your product
    gauge issues get <id> -o json         # the issue's findings, runs, and agents
    gauge run insight <run> -o json       # one run's findings with their issue

Problems show impact by effect: BLOCKED, EXTRA_WORK, RECOVERED, or UNKNOWN.
Reasons show where agents went instead. Some findings are not in an issue yet;
\`issues list\` counts them per product.

## Choose what to improve

- Rank by sessions and effect. BLOCKED and EXTRA_WORK cost agents the most.
- Read the findings and their evidence before you name a cause.
- Prefer issues on surfaces the org owns: its docs, skills, and CLI.
- Improve an issue with \`gauge optimizations create --issue <id>\`:
  \`gauge instructions optimization\`.

Run \`gauge issues -h\` for usage and flag options.
`;
