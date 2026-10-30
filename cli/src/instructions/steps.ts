export type Step = { title: string; command?: string; details: string[] };

function hillclimbSteps(hosted: boolean): Step[] {
  return [
    {
      title: "Identify inputs and propose a pilot",
      command: "gauge instructions hillclimb",
      details: [
        "Inspect this project and the user's goal. Suggest representative tasks, including a mistake or boundary case; explain what they measure.",
        "Choose inputs and the execution backend deliberately. Web fixture JSON supports HTTPS page replacement and origin mapping locally or hosted. GitHub-resolved website previews need hosted execution; supplied docs files do not replace the canonical site.",
      ],
    },
    {
      title: "Prepare and run",
      command: "gauge instructions run",
      details: [
        "Save ongoing measurements with eval/preference; use gauge-cases/ for shared or automated cases. Build/pack inputs, verify cases, and preview.",
        hosted
          ? "Show the user each case's task and criteria, the targets, the session count, and the credit budget, then offer to start the runs with --hosted; say they run on Gauge, separate from this chat."
          : "Check Docker, the runtime image, and agent credentials. Show the user each case's task and criteria, the targets, and the session count, then offer to start the runs; say they run in Docker containers on this machine, separate from this chat. Mention verify and preview only when they fail.",
        ...(hosted
          ? []
          : ["Read gauge instructions init for how to present the plan."]),
      ],
    },
    {
      title: "Analyze evidence",
      command: `gauge instructions session-analysis --${hosted ? "hosted" : "local"}`,
      details: [
        hosted
          ? "Inspect transcripts and hosted analysis. Separate product friction from environment failures and report findings, affected sessions, and coverage."
          : "Read transcripts, judge outcomes, and publish structured analysis. Report findings, affected sessions, and coverage; an empty findings list can be a successful analyzed session.",
      ],
    },
    {
      title: "Improve, rerun, and compare",
      details: [
        "Implement a focused change, rebuild/repack, and rerun affected measurements. Keep tasks, criteria, and models fixed; disclose comparison limits.",
        hosted
          ? "Use gauge run compare --hosted with baseline/candidate request or batch selectors, then inspect whether the original friction disappeared."
          : "Use gauge run compare --local with baseline/candidate batch selectors after publishing analysis; inspect whether the original friction disappeared.",
        "Repeat within the agreed budget. Report before/after evidence, new friction, and anything still unvalidated.",
      ],
    },
  ];
}

export const LOCAL_STEPS = hillclimbSteps(false);
export const HOSTED_STEPS = hillclimbSteps(true);

export function stepsMarkdown(steps: Step[] = LOCAL_STEPS): string {
  return steps
    .map((step, i) =>
      [
        `${i + 1}. **${step.title}**${step.command ? `: \`${step.command}\`` : ""}`,
        ...step.details.map((detail) => `   - ${detail}`),
      ].join("\n"),
    )
    .join("\n");
}
