import { z } from "zod";
import {
  binaryUseSchema,
  inputPathSchema,
  type RunPlanResource,
} from "./runPlan";
import { websiteSourceSchema, websiteUseSchema } from "./websiteInputs";

export const definitionInputSourceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("git") }).strict(),
  z
    .object({
      type: z.literal("github-actions"),
      workflow: inputPathSchema
        .regex(/^\.github\/workflows\/[^/*?{}[\]]+\.ya?ml$/)
        .describe(
          "Workflow file in this repository, for example .github/workflows/build.yml.",
        ),
      artifact: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          "Upload name or pattern. Omit only when the workflow produces exactly one artifact.",
        ),
    })
    .strict(),
]);

export const skillInputPathSchema = z
  .union([z.literal("."), inputPathSchema.regex(/^[^*?{}[\]]+$/)])
  .describe(
    "Explicit Skill directory or ZIP/tar.gz file containing SKILL.md at its root.",
  );

export const runDefinitionInputSchema = z.discriminatedUnion("type", [
  binaryUseSchema
    .extend({ source: definitionInputSourceSchema.default({ type: "git" }) })
    .strict(),
  websiteUseSchema.extend({ source: websiteSourceSchema }).strict(),
  z
    .object({
      type: z.literal("npm-package"),
      source: definitionInputSourceSchema.default({ type: "git" }),
      path: inputPathSchema.describe(
        "Path or glob selecting exactly one packed npm .tgz file.",
      ),
      install: z
        .enum(["environment", "workspace"])
        .default("environment")
        .describe(
          "environment exposes the package's commands on PATH; workspace adds a consumer application dependency.",
        ),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill"),
      source: definitionInputSourceSchema.default({ type: "git" }),
      path: skillInputPathSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("files"),
      source: definitionInputSourceSchema.default({ type: "git" }),
      paths: z
        .array(inputPathSchema)
        .min(1)
        .max(32)
        .describe(
          "Files or globs selected from the committed Git tree or the uploaded artifact.",
        ),
    })
    .strict(),
]);

export function isSkillArchive(path: string): boolean {
  return /\.(?:zip|tar\.gz|tgz)$/i.test(path);
}

export function compileDefinitionInput(
  name: string,
  input: z.infer<typeof runDefinitionInputSchema>,
  repoUrl: string,
  commit: string,
): RunPlanResource {
  if (input.type === "website")
    return {
      name,
      type: "input",
      source: { ...input.source, repoUrl, commit },
      use: {
        type: "website",
        url: input.url,
      },
    };
  const paths =
    input.type === "files" || input.type === "binary"
      ? input.paths
      : input.type === "skill" && !isSkillArchive(input.path)
        ? [input.path === "." ? "**" : `${input.path}/**`]
        : [input.path];
  return {
    name,
    type: "input",
    source:
      input.source.type === "git"
        ? { type: "git", paths, repoUrl, commit }
        : { ...input.source, repoUrl, commit },
    use:
      input.type === "binary"
        ? {
            type: "binary",
            paths: input.paths,
            platform: input.platform,
            commands: input.commands,
          }
        : input.type === "npm-package"
          ? { type: "npm-package", package: input.path, install: input.install }
          : input.type === "skill"
            ? { type: "skill", root: input.path }
            : { type: "files", paths: input.paths },
  };
}
