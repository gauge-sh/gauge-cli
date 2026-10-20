import { minimatch } from "minimatch";
import { inputPathSchema } from "./runPlan";

export function matchInputPaths(
  paths: readonly string[],
  patterns: readonly string[],
  options: { allowEmptySelection?: boolean } = {},
): string[] {
  for (const pattern of patterns) inputPathSchema.parse(pattern);
  const selections = patterns.map((pattern) => ({
    pattern,
    matches: paths.filter((path) =>
      minimatch(path, pattern, { dot: true, nocase: false, nonegate: true }),
    ),
  }));
  if (
    options.allowEmptySelection &&
    selections.every(({ matches }) => matches.length === 0)
  )
    return [];
  const selected = new Set<string>();
  for (const { pattern, matches } of selections) {
    if (!matches.length) throw new Error(`No committed files match ${pattern}`);
    for (const path of matches) selected.add(path);
  }
  return [...selected].sort();
}
