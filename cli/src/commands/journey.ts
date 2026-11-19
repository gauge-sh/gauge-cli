import type { journeys } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type Journey = journeys.Journey;

function journeysPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/journeys`;
}

function journeyPath(org: string, journey: string): string {
  return `${journeysPath(org)}/${encodeURIComponent(journey)}`;
}

function journeyRow(journey: Journey) {
  return {
    id: journey.id,
    name: journey.name,
    evals: journey.evalCount,
    kind: journey.default ? "default" : "custom",
    description: journey.description ?? "",
  };
}

export function registerJourney(evals: Command): void {
  const group = hostedOnly(evals.command("journey")).description(
    "Manage agent journeys: named groups of evals, one per goal an agent has with your product. List a journey's evals with `gauge eval list --journey <journey>`",
  );

  group
    .command("list")
    .description("List agent journeys with their eval counts")
    .action(async (_opts: unknown, cmd: Command) => {
      const res = await createClient().get<journeys.ListJourneysResponse>(
        journeysPath(await resolveOrg(cmd)),
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else printItems(res.items.map(journeyRow), "table");
    });

  group
    .command("get <journey>")
    .description("Show one agent journey (by id or name)")
    .action(async (journey: string, _opts: unknown, cmd: Command) => {
      const found = await createClient().get<Journey>(
        journeyPath(await resolveOrg(cmd), journey),
      );
      if (resolveOutput(cmd) === "json") printJson(found);
      else {
        console.log(`id:          ${found.id}`);
        console.log(`name:        ${found.name}`);
        console.log(`kind:        ${found.default ? "default" : "custom"}`);
        console.log(`evals:       ${found.evalCount}`);
        console.log(`description: ${found.description ?? "(none)"}`);
      }
    });

  group
    .command("create")
    .description("Create an agent journey")
    .requiredOption("--name <name>", "name, unique in the organization")
    .option("--description <text>", "the goal this journey covers")
    .action(
      async (opts: { name: string; description?: string }, cmd: Command) => {
        const created = await createClient().post<Journey>(
          journeysPath(await resolveOrg(cmd)),
          { name: opts.name, description: opts.description },
        );
        if (resolveOutput(cmd) === "json") printJson(created);
        else console.log(`Created journey ${created.id} (${created.name})`);
      },
    );

  group
    .command("edit <journey>")
    .description(
      "Rename or describe a custom agent journey (by id or name). Default journeys cannot be edited.",
    )
    .option("--name <name>", "rename it")
    .option("--description <text>", "replace the description")
    .option("--clear-description", "remove the description")
    .action(
      async (
        journey: string,
        opts: {
          name?: string;
          description?: string;
          clearDescription?: boolean;
        },
        cmd: Command,
      ) => {
        if (opts.description !== undefined && opts.clearDescription)
          throw new CliError(
            "usage",
            "--description and --clear-description conflict",
          );
        const body: journeys.UpdateJourneyBody = {};
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.clearDescription) body.description = null;
        else if (opts.description !== undefined)
          body.description = opts.description;
        if (Object.keys(body).length === 0)
          throw new CliError("usage", "nothing to change");
        const updated = await createClient().patch<Journey>(
          journeyPath(await resolveOrg(cmd), journey),
          body,
        );
        if (resolveOutput(cmd) === "json") printJson(updated);
        else console.log(`Updated journey ${updated.id} (${updated.name})`);
      },
    );

  group
    .command("rm <journey>")
    .description(
      "Delete a custom agent journey (by id or name). Its evals are kept and move to no journey.",
    )
    .action(async (journey: string, _opts: unknown, cmd: Command) => {
      await createClient().delete<void>(
        journeyPath(await resolveOrg(cmd), journey),
      );
      if (resolveOutput(cmd) !== "json")
        console.log(`Deleted journey ${journey}`);
    });
}
