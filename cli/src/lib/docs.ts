import { CliError } from "./client";

export const DOCS_URL = "https://docs.withgauge.com/agents";

export function noCasesError(): CliError {
  return new CliError("not_found", "No case files found in this workspace.", {
    hint: "Plain `gauge init` creates no measurements. Save an eval or preference with `gauge eval create` or `gauge preference create`, then use `gauge run --eval <id>` or `--preference <id>`. For shared case files, read `gauge instructions run`. Start with `gauge instructions hillclimb`.",
  });
}
