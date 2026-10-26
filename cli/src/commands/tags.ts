import type { tags } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { fetchAllPages } from "../lib/paginate";

type Tag = tags.Tag;

function tagsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/tags`;
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("tags"))
    .description("Manage org tags");

  group
    .command("list")
    .description("List tags")
    .action(async (_opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const items = await fetchAllPages<Tag>(createClient(), tagsPath(org));
      if (resolveOutput(cmd) === "json") printJson(items);
      else printItems(items, "table");
    });

  group
    .command("add <name>")
    .description("Add a tag")
    .option("--color <color>", "palette color (e.g. blue, grape; default gray)")
    .action(async (name: string, opts: { color?: string }, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const tag = await createClient().post<Tag>(tagsPath(org), {
        name,
        color: opts.color,
      });
      if (resolveOutput(cmd) === "json") printJson(tag);
      else console.log(`Created tag ${tag.id} (${tag.name}, ${tag.color})`);
    });

  group
    .command("rename <tag> <new-name>")
    .description("Rename a tag (by id or current name)")
    .option("--color <color>", "also change the color")
    .action(
      async (
        tag: string,
        newName: string,
        opts: { color?: string },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        const updated = await createClient().patch<Tag>(
          `${tagsPath(org)}/${encodeURIComponent(tag)}`,
          { name: newName, color: opts.color },
        );
        if (resolveOutput(cmd) === "json") printJson(updated);
        else
          console.log(
            `Renamed tag ${updated.id} to ${updated.name} (${updated.color})`,
          );
      },
    );

  group
    .command("rm <tag>")
    .description("Delete a tag (by id or name)")
    .action(async (tag: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      await createClient().delete(
        `${tagsPath(org)}/${encodeURIComponent(tag)}`,
      );
      if (resolveOutput(cmd) !== "json") console.log(`Deleted tag ${tag}`);
    });
}
