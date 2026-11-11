import {
  experimentSchema,
  type Experiment,
} from "@withgauge/api-schemas/experiments";
import { runDefinitionPublicSubmissionSchema } from "@withgauge/api-schemas/runDefinitions";
import { z } from "zod";
import type { Command } from "commander";
import { CliError, createClient } from "./client";
import { confirmOrAbort } from "./confirm";
import { resolveOrg } from "./context";

export const EXPERIMENT_SCHEMA = () =>
  z.toJSONSchema(experimentSchema, { io: "input" });
export const EXAMPLE_EXPERIMENT = {
  version: 2,
  product: { repository: "example/product", revision: "main" },
  inputs: { docs: { type: "files", paths: ["docs/**"] } },
  cases: [
    {
      key: "first-request",
      prompt: "Use the supplied documentation to write a minimal API client.",
      criteria: [
        {
          name: "Working example",
          rubric: "The client follows the documented API contract.",
        },
      ],
      config: { agents: [{ agent: "CODEX_CLI" }], inputs: ["docs"] },
    },
  ],
} satisfies z.input<typeof experimentSchema>;

export function isExperimentSpec(value: unknown) {
  return (
    value !== null &&
    typeof value === "object" &&
    ("product" in value || "inputs" in value)
  );
}
export function parseExperimentSpec(value: unknown) {
  const result = experimentSchema.safeParse(value);
  if (!result.success)
    throw new CliError(
      "usage",
      `Not a valid experiment specification: ${result.error.message}`,
      {
        hint: "Use gauge run --example --format experiment for a self-contained example.",
      },
    );
  return result.data;
}

export async function loadExperiment(
  command: Command,
  experiment: Experiment,
  options: { dryRun?: boolean; yes?: boolean },
) {
  const org = await resolveOrg(command);
  const client = createClient();
  const response = await client.post<unknown>(
    `/api/v1/orgs/${encodeURIComponent(org)}/run-definitions/resolve`,
    experiment,
  );
  const resolved = z
    .object({
      experiment: experimentSchema,
      definition: runDefinitionPublicSubmissionSchema,
    })
    .parse(response);
  if (
    !/^[a-f0-9]{40}$/.test(resolved.experiment.product.revision) ||
    resolved.definition.source.commit !== resolved.experiment.product.revision
  )
    throw new CliError(
      "internal",
      "Gauge did not return an immutable product revision",
    );
  if (!options.dryRun) {
    console.error(
      `Product: ${resolved.experiment.product.repository} @ ${resolved.experiment.product.revision}`,
    );
    await confirmOrAbort("Run this experiment now?", options.yes);
  }
  return {
    definition: resolved.definition,
    org,
    experiment: resolved.experiment,
    inputSnapshots: [],
    unattachedInputs: Object.keys(experiment.inputs).filter(
      (name) =>
        !experiment.cases.some(
          (item) =>
            item.config.inputs === undefined ||
            item.config.inputs.includes(name),
        ),
    ),
  };
}
