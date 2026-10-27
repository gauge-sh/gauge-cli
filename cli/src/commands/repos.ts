import type {
  Repo,
  RepoSyncResult,
  UpdateRepoBody,
} from "@withgauge/api-schemas/repos";
import type { Command } from "commander";
import { type ApiClient, CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { collect } from "../lib/flags";
import { printItems, printJson } from "../lib/output";
import { fetchAllPages } from "../lib/paginate";

function reposPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/repos`;
}

async function fetchAllRepos(client: ApiClient, org: string): Promise<Repo[]> {
  return fetchAllPages<Repo>(client, reposPath(org));
}

function toRow(repo: Repo) {
  return {
    name: repo.name,
    url: repo.url,
    languages: repo.languages.join(", "),
    frameworks: repo.frameworks.join(", "),
    tags: repo.tags.join(", "),
    size: repo.sizeBucket ?? "",
    stars: repo.stars,
    system: repo.isSystem ? "yes" : "",
  };
}

function syncWarning(repo: Repo): string {
  return `warning: GitHub metadata sync failed; retry with \`gauge repos resync ${repo.url}\``;
}

export function register(program: Command): void {
  const repos = hostedOnly(program.command("repos"))
    .description("Manage repositories");

  repos
    .command("list")
    .description("List repositories (yours + read-only Gauge-provided ones)")
    .action(async (_opts: unknown, command: Command) => {
      const org = await resolveOrg(command);
      const output = resolveOutput(command);
      const items = await fetchAllRepos(createClient(), org);
      if (output === "json") {
        printJson(items);
        return;
      }
      printItems(items.map(toRow), "table");
    });

  repos
    .command("add <url>")
    .description("Add a repository (pulls languages/size/stars from GitHub)")
    .action(async (url: string, _opts: unknown, command: Command) => {
      const org = await resolveOrg(command);
      const output = resolveOutput(command);
      const result = await createClient().post<RepoSyncResult>(reposPath(org), {
        url,
      });
      if (output === "json") {
        printJson(result);
        return;
      }
      console.log(`Added ${result.repo.name} (${result.repo.url})`);
      if (!result.synced) console.error(syncWarning(result.repo));
    });

  repos
    .command("edit <url>")
    .description("Update a repository's display name, frameworks, or tags")
    .option("--name <name>", "display name")
    .option(
      "--framework <name>",
      "REPLACE the framework list (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--tag <name>",
      "REPLACE the tag list (repeatable)",
      collect,
      [] as string[],
    )
    .option("--clear-frameworks", "remove all frameworks")
    .option("--clear-tags", "remove all tags")
    .action(
      async (
        url: string,
        opts: {
          name?: string;
          framework: string[];
          tag: string[];
          clearFrameworks?: boolean;
          clearTags?: boolean;
        },
        command: Command,
      ) => {
        const org = await resolveOrg(command);
        if (opts.framework.length > 0 && opts.clearFrameworks)
          throw new CliError(
            "usage",
            "--framework and --clear-frameworks conflict",
          );
        if (opts.tag.length > 0 && opts.clearTags)
          throw new CliError("usage", "--tag and --clear-tags conflict");
        const body: UpdateRepoBody = { url };
        if (opts.name !== undefined) body.name = opts.name;
        if (opts.clearFrameworks) body.frameworks = [];
        else if (opts.framework.length > 0) body.frameworks = opts.framework;
        if (opts.clearTags) body.tags = [];
        else if (opts.tag.length > 0) body.tags = opts.tag;
        if (Object.keys(body).length === 1)
          throw new CliError("usage", "nothing to change");
        const repo = await createClient().patch<Repo>(reposPath(org), body);
        if (resolveOutput(command) === "json") printJson(repo);
        else console.log(`Updated ${repo.name} (${repo.url})`);
      },
    );

  repos
    .command("resync <url>")
    .description("Re-fetch a repository's GitHub metadata")
    .action(async (url: string, _opts: unknown, command: Command) => {
      const org = await resolveOrg(command);
      const output = resolveOutput(command);
      const result = await createClient().post<RepoSyncResult>(
        `${reposPath(org)}/resync`,
        { url },
      );
      if (output === "json") {
        printJson(result);
        return;
      }
      if (!result.synced) {
        throw new CliError(
          "internal",
          "GitHub metadata sync failed (is the URL a public GitHub repository?)",
        );
      }
      console.log(`Re-synced ${result.repo.name} (${result.repo.url})`);
    });

  repos
    .command("rm <url>")
    .description("Remove a repository from the catalog")
    .action(async (url: string, _opts: unknown, command: Command) => {
      const org = await resolveOrg(command);
      const output = resolveOutput(command);
      await createClient().delete<void>(reposPath(org), { url });
      if (output !== "json") console.log(`Removed ${url}`);
    });
}
