import { z } from "zod";
import { preferenceDefinitionSchema } from "./preference";
import { runDefinitionInputSchema } from "./runDefinitionInputs";
import {
  runDefinitionConfigSchema,
  runDefinitionCriterionSchema,
} from "./runDefinitions";

export const experimentProductSchema = z
  .object({
    repository: z
      .string()
      .regex(
        /^(?:https:\/\/github\.com\/)?[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/,
        "Use owner/repository or an HTTPS GitHub repository URL without credentials",
      )
      .refine(
        (value) => ![".", ".."].includes(value.split("/").at(-1) ?? ""),
        "Invalid repository name",
      ),
    revision: z
      .string()
      .trim()
      .min(1)
      .max(255)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control bytes in supplied Git references.
      .regex(/^[^\s\x00-\x1f\x7f]+$/, "Use a commit SHA, branch, or tag"),
  })
  .strict();

export const experimentInputsSchema = z
  .record(
    z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    runDefinitionInputSchema,
  )
  .refine(
    (inputs) => Object.keys(inputs).length <= 32,
    "At most 32 inputs are allowed",
  )
  .meta({ maxProperties: 32 });

/** The task's consumer workspace is configured in each case, independently of product inputs. */
export const experimentCaseSchema = z
  .object({
    key: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    prompt: z.string().trim().min(1),
    criteria: z.array(runDefinitionCriterionSchema).min(1).optional(),
    preference: preferenceDefinitionSchema.optional(),
    config: runDefinitionConfigSchema,
  })
  .strict()
  .refine(
    (item) => Boolean(item.criteria) !== Boolean(item.preference),
    "Specify exactly one of criteria or preference",
  );

/** An authored hosted experiment, independent of the caller's working directory. */
export const experimentSchema = z
  .object({
    version: z.literal(2),
    product: experimentProductSchema,
    inputs: experimentInputsSchema,
    cases: z.array(experimentCaseSchema).min(1).max(20),
  })
  .strict()
  .superRefine((experiment, ctx) => {
    const keys = new Set<string>();
    for (const [index, item] of experiment.cases.entries()) {
      if (keys.has(item.key))
        ctx.addIssue({
          code: "custom",
          path: ["cases", index, "key"],
          message: "Case keys must be unique",
        });
      keys.add(item.key);
      for (const name of item.config.inputs ?? []) {
        if (!Object.hasOwn(experiment.inputs, name))
          ctx.addIssue({
            code: "custom",
            path: ["cases", index, "config", "inputs"],
            message: `Unknown input: ${name}`,
          });
      }
    }
  });
export type Experiment = z.infer<typeof experimentSchema>;

export function experimentRepositoryUrl(repository: string) {
  const parsed = experimentProductSchema.shape.repository.parse(repository);
  return `https://github.com/${parsed.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}`;
}
