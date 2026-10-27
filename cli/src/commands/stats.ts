import type { stats } from "@withgauge/api-schemas";
import type { Command } from "commander";
import { CliError, createClient, type Query } from "../lib/client";
import { hostedOnly, resolveOrg, resolveOutput } from "../lib/context";
import { printItems, printJson } from "../lib/output";

type FilterOpts = {
  prompt?: string;
  tag?: string;
  repo?: string;
  language?: string;
  framework?: string;
  size?: string;
  branded?: boolean;
  unbranded?: boolean;
  limit?: string;
  full?: boolean;
};

function addFilterOptions(cmd: Command): Command {
  return cmd
    .option("--prompt <id>", "filter to a single prompt")
    .option("--tag <ids>", "comma-separated tag ids")
    .option("--repo <urls>", "comma-separated base repo urls")
    .option("--language <langs>", "comma-separated repo languages")
    .option("--framework <names>", "comma-separated repo frameworks")
    .option("--size <buckets>", "comma-separated codebase-size buckets")
    .option("--branded", "only branded prompts")
    .option("--unbranded", "only non-branded prompts")
    .option("--limit <n>", "max rows (default 50)")
    .option("--full", "return all rows (up to 1000)");
}

function filterQuery(opts: FilterOpts): Query {
  if (opts.branded && opts.unbranded) {
    throw new CliError("usage", "Pass at most one of --branded / --unbranded.");
  }
  return {
    prompt: opts.prompt,
    tag: opts.tag,
    repo: opts.repo,
    language: opts.language,
    framework: opts.framework,
    size: opts.size,
    branded: opts.branded ? "true" : opts.unbranded ? "false" : undefined,
    limit: opts.full ? "1000" : opts.limit,
  };
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`;
const delta = (d: number | null): string =>
  d === null || d === 0 ? "—" : d > 0 ? `+${d}` : String(d);

function noteFreshness(f: stats.StatsFreshness): void {
  if (!f.available) {
    console.error(
      "warning: analytics store is temporarily unavailable; results may be incomplete.",
    );
  } else if (f.pending > 0) {
    console.error(
      `note: ${f.pending} recent run(s) still ingesting; results may not reflect them yet.`,
    );
  }
}

async function runStats<R>(
  command: Command,
  resource: string,
  opts: FilterOpts,
  toRow: (item: R) => Record<string, unknown>,
): Promise<void> {
  const org = await resolveOrg(command);
  const output = resolveOutput(command);
  const res = await createClient().get<{
    items: R[];
    freshness: stats.StatsFreshness;
  }>(
    `/api/v1/orgs/${encodeURIComponent(org)}/stats/${resource}`,
    filterQuery(opts),
  );
  if (output === "json") {
    printJson(res);
    return;
  }
  printItems(res.items.map(toRow), "table");
  noteFreshness(res.freshness);
}

const rankingRow = (r: stats.BrandRanking) => ({
  rank: r.rank,
  brand: r.brandName,
  kind: r.kind,
  installs: r.installs,
  "install%": pct(r.installRate),
  "mention%": pct(r.mentionRate),
  delta: delta(r.deltaRank),
});

const packageRow = (r: stats.PackageRate) => ({
  package: r.name,
  ecosystem: r.ecosystem,
  brand: r.brandName,
  kind: r.kind,
  installs: r.installs,
  rate: pct(r.rate),
});

const brandRow = (r: stats.BrandRate) => ({
  brand: r.brandName,
  kind: r.kind,
  installs: r.installs,
  rate: pct(r.rate),
});

const funnelRow = (r: stats.BrandFunnelRow) => ({
  brand: r.brandName,
  kind: r.kind,
  "mention%": pct(r.mentionRate),
  "install%": pct(r.installRate),
});

const domainRow = (r: stats.DomainRate) => ({
  domain: r.domain,
  brand: r.brandName,
  runs: r.runs,
  rate: pct(r.rate),
  requests: r.requests,
});

export function register(program: Command): void {
  const group = hostedOnly(program.command("stats"))
    .description("Read-only analytics over your runs");

  addFilterOptions(
    group.command("rankings").description("Brands ranked by install rate"),
  ).action((opts: FilterOpts, command: Command) =>
    runStats<stats.BrandRanking>(command, "rankings", opts, rankingRow),
  );

  addFilterOptions(
    group
      .command("installs")
      .description("Package install rates (share of voice)"),
  ).action((opts: FilterOpts, command: Command) =>
    runStats<stats.PackageRate>(command, "installs", opts, packageRow),
  );

  addFilterOptions(
    group
      .command("brands")
      .description("Per-brand (company-level) install rates"),
  ).action((opts: FilterOpts, command: Command) =>
    runStats<stats.BrandRate>(command, "brands", opts, brandRow),
  );

  addFilterOptions(
    group
      .command("funnel")
      .description("Per-brand mention rate beside install rate"),
  ).action((opts: FilterOpts, command: Command) =>
    runStats<stats.BrandFunnelRow>(command, "funnel", opts, funnelRow),
  );

  addFilterOptions(
    group
      .command("domains")
      .description("Outbound fetch rates by registrable domain"),
  ).action((opts: FilterOpts, command: Command) =>
    runStats<stats.DomainRate>(command, "domains", opts, domainRow),
  );
}
