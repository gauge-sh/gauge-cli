import { readFileSync } from "node:fs";
import { batteries } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { z } from "zod";
import { CliError, createClient } from "./client";
import { resolveOrg, resolveOutput } from "./context";
import { printJson } from "./output";

type BatteryPlan = batteries.BatteryPlan;
type BatteryApplyResponse = batteries.BatteryApplyResponse;

export function assertRequiredExperiment(
  spec: batteries.BatterySpec,
  required: string,
): void {
  if (required.length === 0) {
    throw new CliError(
      "invalid_request",
      "--require-experiment requires a nonempty label",
    );
  }
  const mismatches: string[] = [];
  for (const [promptIndex, prompt] of spec.prompts.entries()) {
    const promptExperiment = prompt.experiment ?? spec.experiment;
    const schedules = prompt.schedules ?? [{}];
    if (schedules.length === 0) {
      mismatches.push(`prompts.${promptIndex}.schedules`);
    }
    for (const [scheduleIndex, schedule] of schedules.entries()) {
      if ((schedule.experiment ?? promptExperiment) !== required) {
        mismatches.push(`prompts.${promptIndex}.schedules.${scheduleIndex}`);
      }
    }
  }
  if (mismatches.length > 0) {
    throw new CliError(
      "invalid_request",
      `--require-experiment expected every target to resolve to ${JSON.stringify(required)}; mismatched: ${mismatches.join(", ")}`,
    );
  }
}

export const EXAMPLE_SPEC: batteries.BatterySpec = {
  version: 1,
  expand: true,
  experiment: "my-experiment",
  defaults: { agents: ["CLAUDE_CODE"], samplesPerCycle: 3 },
  prompts: [
    {
      key: "add-healthcheck",
      text: "Add a /health endpoint that returns 200 OK.",
    },
    {
      key: "migrate-to-vitest",
      text: "Migrate the test suite from Jest to Vitest.",
      schedules: [
        {
          repoUrl: "https://github.com/acme/api",
          repoRef: "main",
          model: "claude-opus-4-8",
        },
      ],
    },
  ],
};

export async function readSpecJson(source: string): Promise<unknown> {
  let raw: string;
  if (source === "-") {
    if (process.stdin.isTTY)
      throw new CliError("usage", "--apply - needs a run spec piped to stdin");
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks).toString("utf8");
  } else {
    try {
      raw = readFileSync(source, "utf8");
    } catch (e) {
      throw new CliError(
        "usage",
        `cannot read spec file ${source}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new CliError(
      "invalid_request",
      `spec is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export function parseSpec(parsed: unknown): batteries.BatterySpec {
  const result = batteries.batterySpecSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(spec)"}: ${i.message}`)
      .join("\n");
    throw new CliError(
      "invalid_request",
      `not a valid battery spec:\n${details}`,
      {
        hint: "Run `gauge run --schema --hosted` for the full schema, or `gauge run --example --hosted` for a starter.",
      },
    );
  }
  return result.data;
}

async function resolveApplyOrg(
  command: Command,
  spec: batteries.BatterySpec,
): Promise<string> {
  return resolveOrg(command, spec.org);
}

function repoLabel(repoUrl: string | null, repoRef: string | null): string {
  if (!repoUrl) return "greenfield";
  return repoRef ? `${repoUrl}@${repoRef}` : repoUrl;
}

function printPlan(plan: BatteryPlan): void {
  console.log(
    `Plan for org ${plan.org}` +
      (plan.experiment ? ` (experiment: ${plan.experiment})` : ""),
  );
  for (const prompt of plan.prompts) {
    console.log(`  ${prompt.action} prompt "${prompt.key}"`);
    for (const s of prompt.schedules) {
      console.log(
        `    ${s.action} schedule ${repoLabel(s.repoUrl, s.repoRef)}` +
          (plan.expand ? ` → ${s.runs} run(s)` : ""),
      );
    }
  }
  const sum = plan.summary;
  console.log(
    `Prompts: ${sum.promptsToCreate} to create, ${sum.promptsToUpdate} to update; ` +
      `schedules: ${sum.schedulesToCreate} to create, ${sum.schedulesToUpdate} to update`,
  );
  if (plan.expand) {
    const byAgent = Object.entries(sum.runsByAgent)
      .map(([agent, n]) => `${agent}: ${n}`)
      .join(", ");
    console.log(
      `Runs to enqueue: ${sum.runsToEnqueue}${byAgent ? ` (${byAgent})` : ""}` +
        ` — estimated ${sum.estimatedCredits} credits`,
    );
  } else {
    console.log(
      'No runs will be enqueued (config only — set "expand": true to run).',
    );
  }
  console.log("Dry run — nothing was applied.");
}

function printApplied(res: BatteryApplyResponse): void {
  console.log(
    `Applied${res.experiment ? ` (experiment: ${res.experiment})` : ""} — ` +
      `${res.batchIds.length} batch(es), ${res.runIds.length} run(s) enqueued`,
  );
  for (const id of res.runIds) console.log(`  run ${id}`);
  if (res.runIds.length > 0) {
    console.error(`(watch one live: gauge run watch ${res.runIds[0]})`);
  }
  if (res.blocked) {
    console.error(
      `warning: some schedules were not expanded (${res.blocked}) — ` +
        "re-apply after resolving to enqueue the rest",
    );
  }
}

export const BATTERY_SCHEMA = () => z.toJSONSchema(batteries.batterySpecSchema);

export async function applySpec(
  command: Command,
  spec: batteries.BatterySpec,
  opts: { dryRun?: boolean; requireExperiment?: string },
): Promise<void> {
  if (opts.requireExperiment !== undefined)
    assertRequiredExperiment(spec, opts.requireExperiment);
  const org = await resolveApplyOrg(command, spec);
  const result = await createClient().post<BatteryPlan | BatteryApplyResponse>(
    `/api/v1/orgs/${encodeURIComponent(org)}/batteries`,
    spec,
    opts.dryRun ? { dryRun: 1 } : undefined,
  );
  if (resolveOutput(command) === "json") printJson(result);
  else if (opts.dryRun) printPlan(result as BatteryPlan);
  else printApplied(result as BatteryApplyResponse);
}
