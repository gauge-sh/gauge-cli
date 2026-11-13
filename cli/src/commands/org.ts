import type { billing, orgs } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printJson } from "../lib/output";
import { fmtOverage } from "./billing";

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

function parseWeekday(raw: string): number {
  const value = raw.trim().toLowerCase();
  const day = /^[0-6]$/.test(value)
    ? Number(value)
    : WEEKDAYS.findIndex((d) => value.length >= 3 && d.startsWith(value));
  if (day < 0)
    throw new CliError(
      "usage",
      `invalid --preference-day "${raw}" (expected a weekday name, such as monday)`,
    );
  return day;
}

function parsePreferenceCadence(
  raw: string,
): orgs.UpdatePreferenceScheduleBody["cadence"] {
  const cadence = raw.trim().toUpperCase();
  if (cadence !== "DAILY" && cadence !== "WEEKLY")
    throw new CliError(
      "usage",
      `invalid --preference-cadence "${raw}" (expected daily or weekly)`,
    );
  return cadence;
}

function weekdayLabel(day: number): string {
  const name = WEEKDAYS[day];
  return name ? `${name[0].toUpperCase()}${name.slice(1)}s` : String(day);
}

function scheduleLabel(s: orgs.PreferenceSchedule): string {
  const when =
    s.cadence === "DAILY"
      ? "daily"
      : `weekly on ${weekdayLabel(s.weeklyRunDay)}`;
  return `${when} (next run: ${s.nextRunAt ?? "not set yet"})`;
}

function printSettings(
  s: orgs.OrgSettings,
  billingStatus: billing.BillingStatus,
): void {
  console.log(`slug:            ${s.slug}`);
  console.log(`name:            ${s.name}`);
  console.log(`website:         ${s.website ?? "(none)"}`);
  console.log(
    `max spend/run:   ${s.maxSpendUsd == null ? "(server default)" : `$${s.maxSpendUsd}`}`,
  );
  console.log(`overage:         ${fmtOverage(billingStatus)}`);
  console.log(`auto-join:       ${s.autoJoinDomain ?? "off"}`);
  if (s.preferenceSchedule)
    console.log(`preference runs: ${scheduleLabel(s.preferenceSchedule)}`);
}

type EditOpts = { preferenceCadence?: string; preferenceDay?: string };

async function editOrg(cmd: Command, opts: EditOpts): Promise<void> {
  const body: orgs.UpdatePreferenceScheduleBody = {};
  if (opts.preferenceCadence !== undefined)
    body.cadence = parsePreferenceCadence(opts.preferenceCadence);
  if (opts.preferenceDay !== undefined)
    body.weeklyRunDay = parseWeekday(opts.preferenceDay);
  if (Object.keys(body).length === 0)
    throw new CliError(
      "usage",
      "nothing to change (pass --preference-cadence or --preference-day)",
    );
  const org = await resolveOrg(cmd);
  const schedule = await createClient().patch<orgs.PreferenceSchedule>(
    `/api/v1/orgs/${encodeURIComponent(org)}/preference-schedule`,
    body,
  );
  if (resolveOutput(cmd) === "json") printJson(schedule);
  else console.log(`preference runs: ${scheduleLabel(schedule)}`);
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("org")).description(
    "This org's settings (see `gauge orgs` for the org list)",
  );

  group
    .command("get")
    .description("Show the org's settings")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const client = createClient();
      const base = `/api/v1/orgs/${encodeURIComponent(org)}`;
      const [settings, billingStatus] = await Promise.all([
        client.get<orgs.OrgSettings>(base),
        client.get<billing.BillingStatus>(`${base}/billing`),
      ]);
      if (resolveOutput(cmd) === "json")
        printJson({
          ...settings,
          paymentType: billingStatus.paymentType ?? null,
          creditLine: billingStatus.creditLine ?? null,
        });
      else printSettings(settings, billingStatus);
    });

  group
    .command("edit")
    .description(
      "Set when tracked preference prompts run. Edit other settings in the web app",
    )
    .option("--preference-cadence <cadence>", "daily | weekly")
    .option(
      "--preference-day <weekday>",
      "weekly run day, such as monday",
    )
    .action(async (opts: EditOpts, cmd: Command) => {
      await editOrg(cmd, opts);
    });
}
