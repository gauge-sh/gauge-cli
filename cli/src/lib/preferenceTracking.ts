import type { orgs, visibility } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "./client";
import { resolveOrg, resolveOutput } from "./context";
import { buildAgentRoster } from "./flags";
import { printJson } from "./output";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function orgPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}`;
}

export function parseWeekday(raw: string): number {
  const value = raw.trim().toLowerCase();
  const day = /^[0-6]$/.test(value)
    ? Number(value)
    : WEEKDAYS.findIndex((d) => value.length >= 3 && d.startsWith(value));
  if (day < 0)
    throw new CliError(
      "usage",
      `invalid --day "${raw}" (expected a weekday name, such as monday)`,
    );
  return day;
}

export function parseCadence(
  raw: string,
): NonNullable<orgs.UpdatePreferenceScheduleBody["cadence"]> {
  const cadence = raw.trim().toUpperCase();
  if (cadence !== "DAILY" && cadence !== "WEEKLY")
    throw new CliError(
      "usage",
      `invalid --cadence "${raw}" (expected daily or weekly)`,
    );
  return cadence;
}

function weekdayLabel(day: number): string {
  const name = WEEKDAYS[day];
  return name ? `${name[0].toUpperCase()}${name.slice(1)}s` : String(day);
}

export function scheduleLabel(s: orgs.PreferenceSchedule): string {
  return s.cadence === "DAILY"
    ? "daily"
    : `weekly on ${weekdayLabel(s.weeklyRunDay)}`;
}

export function rosterLabel(
  agents: { agent: string; models: string[] }[],
): string {
  if (agents.length === 0) return "none (tracked prompts do not run)";
  return agents
    .flatMap(({ agent, models }) =>
      models.length
        ? models.map((model) => `${model} (${agent.toLowerCase()})`)
        : [`${agent.toLowerCase()} default`],
    )
    .join(", ");
}

function printTracking(
  schedule: orgs.PreferenceSchedule,
  counts?: { tracked: number; total: number },
): void {
  console.log(`schedule: ${scheduleLabel(schedule)}`);
  console.log(`next run: ${schedule.nextRunAt ?? "not set yet"}`);
  if (schedule.agents) console.log(`models:   ${rosterLabel(schedule.agents)}`);
  if (counts)
    console.log(`tracking: ${counts.tracked} of ${counts.total} prompts`);
}

export async function showTracking(cmd: Command): Promise<void> {
  const base = orgPath(await resolveOrg(cmd));
  const client = createClient();
  const [settings, prompts] = await Promise.all([
    client.get<orgs.OrgSettings>(base),
    client.get<visibility.ListVisibilityPromptsResponse>(
      `${base}/visibility-prompts`,
    ),
  ]);
  const schedule = settings.preferenceSchedule;
  if (!schedule)
    throw new CliError(
      "upgrade_required",
      "This Gauge server does not support preference tracking yet",
    );
  const counts = {
    tracked: prompts.items.filter((prompt) => prompt.tracked).length,
    total: prompts.items.length,
  };
  if (resolveOutput(cmd) === "json") printJson({ ...schedule, ...counts });
  else printTracking(schedule, counts);
}

export type TrackingSetOpts = {
  cadence?: string;
  day?: string;
  agent: string[];
  agents?: boolean;
};

export async function setTracking(
  cmd: Command,
  opts: TrackingSetOpts,
): Promise<void> {
  const body: orgs.UpdatePreferenceScheduleBody = {};
  if (opts.cadence !== undefined) body.cadence = parseCadence(opts.cadence);
  if (opts.day !== undefined) body.weeklyRunDay = parseWeekday(opts.day);
  if (opts.agents === false) {
    if (opts.agent.length > 0)
      throw new CliError("usage", "--agent and --no-agents conflict");
    body.agents = [];
  } else if (opts.agent.length > 0) body.agents = buildAgentRoster(opts.agent);
  if (Object.keys(body).length === 0)
    throw new CliError(
      "usage",
      "nothing to change (pass --cadence, --day, --agent, or --no-agents)",
    );
  const schedule = await createClient().patch<orgs.PreferenceSchedule>(
    `${orgPath(await resolveOrg(cmd))}/preference-schedule`,
    body,
  );
  if (resolveOutput(cmd) === "json") printJson(schedule);
  else {
    printTracking(schedule);
    if (body.agents?.length === 0)
      console.error(
        "warning: no models are tracked, so tracked prompts stop running",
      );
  }
}

export async function setPromptsTracked(
  cmd: Command,
  ids: string[],
  tracked: boolean,
): Promise<void> {
  const base = `${orgPath(await resolveOrg(cmd))}/visibility-prompts`;
  const client = createClient();
  const updated = await Promise.all(
    [...new Set(ids)].map((id) =>
      client.patch<visibility.VisibilityPrompt>(
        `${base}/${encodeURIComponent(id)}`,
        { tracked },
      ),
    ),
  );
  if (resolveOutput(cmd) === "json")
    printJson(updated.map(({ id, tracked }) => ({ id, tracked })));
  else
    console.log(
      `${tracked ? "Tracked" : "Untracked"} ${updated.length} preference ${updated.length === 1 ? "prompt" : "prompts"}`,
    );
}
