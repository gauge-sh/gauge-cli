import { brands } from "@withgauge/api-schemas";
import { type Command, Option } from "commander";
import { CliError, createClient } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";
import { fetchAllPages } from "../lib/paginate";

type Brand = brands.Brand;
type BrandPackageInput = brands.BrandPackageInput;

const KINDS = brands.BRAND_KINDS.map((k) => k.toLowerCase());
const ECOSYSTEMS = brands.BRAND_PACKAGE_ECOSYSTEMS;

function brandsPath(org: string): string {
  return `/api/v1/orgs/${encodeURIComponent(org)}/brands`;
}

function collect(value: string, previous?: string[]): string[] {
  return previous ? [...previous, value] : [value];
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function parsePackage(raw: string): BrandPackageInput {
  const sep = raw.lastIndexOf(":");
  if (sep === -1) return { name: raw.trim(), ecosystem: null };
  const name = raw.slice(0, sep).trim();
  const ecosystem = raw.slice(sep + 1).trim();
  if (!name) throw new CliError("usage", `Invalid package "${raw}"`);
  if (!(ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
    throw new CliError(
      "usage",
      `Invalid ecosystem "${ecosystem}" (expected ${ECOSYSTEMS.join("|")})`,
    );
  }
  return { name, ecosystem: ecosystem as BrandPackageInput["ecosystem"] };
}

function toRow(brand: Brand): Record<string, unknown> {
  return {
    id: brand.id,
    name: brand.name,
    kind: brand.kind.toLowerCase(),
    aliases: brand.aliases.join(", "),
    websites: brand.websites.join(", "),
    packages: brand.packages.map((p) => p.name).join(", "),
  };
}

export function register(program: Command): void {
  const group = hostedOnly(program.command("brands"))
    .description("Manage org brands");

  group
    .command("list")
    .description("List brands")
    .addOption(new Option("--kind <kind>", "filter by kind").choices(KINDS))
    .action(async (opts: { kind?: string }, cmd: Command) => {
      const org = await resolveOrg(cmd);
      const items = await fetchAllPages<Brand>(
        createClient(),
        brandsPath(org),
        {
          kind: opts.kind?.toUpperCase(),
        },
      );
      if (resolveOutput(cmd) === "json") {
        printJson(items);
        return;
      }
      printItems(items.map(toRow), "table");
    });

  group
    .command("add <name>")
    .description("Add a brand")
    .addOption(
      new Option("--kind <kind>", "brand kind")
        .choices(KINDS)
        .makeOptionMandatory(),
    )
    .option("--aliases <list>", "comma-separated alias spellings")
    .option("--websites <list>", "comma-separated docs/marketing URLs")
    .option(
      "--package <name[:ecosystem]>",
      "package identifier, repeatable (ecosystem: npm|pypi|cargo|go|rubygems|other)",
      collect,
    )
    .action(
      async (
        name: string,
        opts: {
          kind: string;
          aliases?: string;
          websites?: string;
          package?: string[];
        },
        cmd: Command,
      ) => {
        const org = await resolveOrg(cmd);
        const row = await createClient().post<Brand>(brandsPath(org), {
          name,
          kind: opts.kind.toUpperCase(),
          aliases: opts.aliases === undefined ? [] : splitList(opts.aliases),
          websites: opts.websites === undefined ? [] : splitList(opts.websites),
          packages: (opts.package ?? []).map(parsePackage),
        });
        if (resolveOutput(cmd) === "json") printJson(row);
        else console.log(`Created brand ${row.id} (${row.name})`);
      },
    );

  group
    .command("edit <id>")
    .description("Update a brand (only the provided fields change)")
    .option("--name <name>", "new canonical name")
    .addOption(new Option("--kind <kind>", "new kind").choices(KINDS))
    .option(
      "--aliases <list>",
      "replace aliases (comma-separated; pass '' to clear)",
    )
    .option(
      "--websites <list>",
      "replace websites (comma-separated; pass '' to clear)",
    )
    .option(
      "--package <name[:ecosystem]>",
      "replace packages, repeatable",
      collect,
    )
    .option("--clear-packages", "remove all packages")
    .action(
      async (
        id: string,
        opts: {
          name?: string;
          kind?: string;
          aliases?: string;
          websites?: string;
          package?: string[];
          clearPackages?: boolean;
        },
        cmd: Command,
      ) => {
        const patch: Record<string, unknown> = {};
        if (opts.name !== undefined) patch.name = opts.name;
        if (opts.kind !== undefined) patch.kind = opts.kind.toUpperCase();
        if (opts.aliases !== undefined) patch.aliases = splitList(opts.aliases);
        if (opts.websites !== undefined)
          patch.websites = splitList(opts.websites);
        if (opts.clearPackages) patch.packages = [];
        else if (opts.package !== undefined)
          patch.packages = opts.package.map(parsePackage);
        if (Object.keys(patch).length === 0) {
          throw new CliError(
            "usage",
            "Nothing to update — pass at least one of --name/--kind/--aliases/--websites/--package/--clear-packages.",
          );
        }
        const org = await resolveOrg(cmd);
        const row = await createClient().patch<Brand>(
          `${brandsPath(org)}/${encodeURIComponent(id)}`,
          patch,
        );
        if (resolveOutput(cmd) === "json") printJson(row);
        else console.log(`Updated brand ${row.id} (${row.name})`);
      },
    );

  group
    .command("rm <id>")
    .description("Delete a brand")
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const org = await resolveOrg(cmd);
      await createClient().delete(
        `${brandsPath(org)}/${encodeURIComponent(id)}`,
      );
      if (resolveOutput(cmd) !== "json") console.log(`Deleted brand ${id}`);
    });
}
