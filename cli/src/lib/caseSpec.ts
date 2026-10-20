import { createHash } from "node:crypto";
import { preferenceDefinitionSchema } from "@withgauge/api-schemas/preference";
import {
  type RunDefinitionCase,
  runDefinitionConfigSchema,
  runDefinitionCriterionSchema,
} from "@withgauge/api-schemas/runDefinitions";
import { z } from "zod";
import { CliError } from "./client";

export const caseSpecSchema = z
  .object({
    version: z.literal(2),
    cases: z
      .array(
        z
          .object({
            key: z
              .string()
              .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
              .max(64)
              .describe("Unique case id, lowercase-kebab"),
            prompt: z.string().trim().min(1).describe("The user's request"),
            criteria: z
              .array(runDefinitionCriterionSchema)
              .min(1)
              .optional()
              .describe("Optional for local runs; hosted needs criteria or preference"),
            preference: preferenceDefinitionSchema.optional(),
            config: runDefinitionConfigSchema,
          })
          .strict()
          .refine(
            (item) => !(item.criteria && item.preference),
            "Specify criteria or preference, not both",
          ),
      )
      .min(1)
      .max(20),
  })
  .strict()
  .refine(
    (spec) =>
      new Set(spec.cases.map((item) => item.key)).size === spec.cases.length,
    "Case keys must be unique",
  );
export type CaseSpec = z.infer<typeof caseSpecSchema>;

export const EXAMPLE_CASE_SPEC: z.input<typeof caseSpecSchema> = {
  version: 2,
  cases: [
    {
      key: "release-notes",
      prompt:
        "Write the release notes for version 1.2.0. We added dark mode and fixed a login crash.",
      criteria: [
        {
          name: "Team format",
          rubric: "RELEASE-NOTES.md lists both changes in the team's format.",
        },
      ],
      config: { agents: [{ agent: "CODEX_CLI" }], inputs: ["release-notes"] },
    },
  ],
};

export const CASE_SPEC_SCHEMA = () => z.toJSONSchema(caseSpecSchema);

export function isCaseSpec(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "cases" in value &&
    !("prompts" in value)
  );
}

export function parseCaseSpec(value: unknown): CaseSpec {
  const result = caseSpecSchema.safeParse(value);
  if (!result.success)
    throw new CliError(
      "usage",
      `not a valid case spec:\n${result.error.issues
        .map((i) => `  ${i.path.join(".") || "(spec)"}: ${i.message}`)
        .join("\n")}`,
      {
        hint: "Run `gauge run --schema --local` for the full schema, or `gauge run --example --local` for a starter.",
      },
    );
  return result.data;
}

export function caseSpecCases(spec: CaseSpec): RunDefinitionCase[] {
  return spec.cases.map(({ key, ...item }) => ({ path: key, ...item }));
}

export function caseSpecDigest(spec: CaseSpec): string {
  return `sha256:${createHash("sha256")
    .update("gauge-case-spec-v2\0")
    .update(JSON.stringify(spec))
    .digest("hex")}`;
}
