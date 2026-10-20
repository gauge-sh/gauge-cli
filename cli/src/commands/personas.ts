import type { personas } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

function personasPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/personas`;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("personas"))
    .description("Manage simulated-user personas for eval and preference runs");

  group
    .command("list")
    .description("List the org's personas")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const res = await createClient().get<personas.ListPersonasResponse>(
        personasPath(org),
      );
      if (resolveOutput(cmd) === "json") printJson(res.items);
      else
        printItems(
          res.items.map((p) => ({
            id: p.id,
            name: p.name,
            description:
              p.description.length > 60
                ? `${p.description.slice(0, 57)}...`
                : p.description,
          })),
          "table",
        );
    });

  group
    .command("get <id>")
    .description("Show one persona")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      const persona = await createClient().get<personas.Persona>(
        `${personasPath(org)}/${encodeURIComponent(id)}`,
      );
      if (resolveOutput(cmd) === "json") {
        printJson(persona);
        return;
      }
      console.log(`id:          ${persona.id}`);
      console.log(`name:        ${persona.name}`);
      console.log(`model:       ${persona.model}`);
      console.log(`description: ${persona.description}`);
    });

  group
    .command("add")
    .description("Create a persona")
    .requiredOption("--name <name>", "persona name")
    .requiredOption(
      "--description <text>",
      'memory-style notes ("The user is a solo founder…")',
    )
    .action(
      async (opts: { name: string; description: string }, cmd: Command) => {
        const org = resolveOrg(cmd);
        const created = await createClient().post<personas.Persona>(
          personasPath(org),
          { name: opts.name, description: opts.description },
        );
        if (resolveOutput(cmd) === "json") printJson(created);
        else console.log(`Created persona ${created.id} (${created.name})`);
      },
    );

  group
    .command("edit <id>")
    .description("Update a persona")
    .option("--name <name>", "rename the persona")
    .option("--description <text>", "replace the notes")
    .action(
      async (
        id: string,
        opts: { name?: string; description?: string },
        cmd: Command,
      ) => {
        const org = resolveOrg(cmd);
        if (opts.name === undefined && opts.description === undefined)
          throw new CliError("usage", "nothing to change");
        const updated = await createClient().patch<personas.Persona>(
          `${personasPath(org)}/${encodeURIComponent(id)}`,
          { name: opts.name, description: opts.description },
        );
        if (resolveOutput(cmd) === "json") printJson(updated);
        else console.log(`Updated persona ${updated.id}`);
      },
    );

  group
    .command("rm <id>")
    .description(
      "Delete a persona (run configurations fall back to the default persona)",
    )
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const org = resolveOrg(cmd);
      await createClient().delete<void>(
        `${personasPath(org)}/${encodeURIComponent(id)}`,
      );
      if (resolveOutput(cmd) !== "json") console.log(`Deleted persona ${id}`);
    });
}
