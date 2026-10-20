import { z } from "zod";
import {
  commentSourceSchema,
  deploymentSourceSchema,
  websiteUseSchema,
} from "./websiteInputs";

export const inputPathSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^(?![!/])(?!.*[\\\x00-\x1f\x7f])(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)(?!.*\/$).+$/,
    "Expected a repository-relative path or glob without traversal",
  );
export const reservedBinaryCommands = [
  "bash",
  "sh",
  "zsh",
  "env",
  "node",
  "nodejs",
  "npm",
  "npx",
  "bun",
  "python",
  "python3",
  "git",
  "tar",
  "curl",
  "cp",
  "chmod",
  "mkdir",
  "rm",
  "ln",
  "test",
  "sha256sum",
  "printenv",
  "uname",
  "claude",
  "codex",
  "opencode",
  "pi",
  "wizard",
] as const;
export const binaryCommandSchema = z
  .string()
  .max(128)
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/,
    "Expected a command name without paths or shell syntax",
  )
  .refine(
    (name) => !(reservedBinaryCommands as readonly string[]).includes(name),
    "Command is reserved for Gauge workspace setup or the agent harness; choose another command name",
  );
export const binaryUseSchema = z
  .object({
    type: z.literal("binary"),
    paths: z.array(inputPathSchema).min(1).max(32),
    platform: z
      .literal("linux-x64")
      .describe(
        "Linux x86-64 ELF executables compatible with the consumer sandbox. No system packages are installed.",
      ),
    commands: z
      .record(
        binaryCommandSchema,
        inputPathSchema.regex(
          /^[^*?{}[\]]+$/,
          "Command targets must be explicit relative file paths",
        ),
      )
      .refine(
        (commands) =>
          Object.keys(commands).length >= 1 &&
          Object.keys(commands).length <= 32,
        "Declare between 1 and 32 commands",
      )
      .meta({ minProperties: 1, maxProperties: 32 }),
  })
  .strict();

export const inputUseSchema = z.discriminatedUnion("type", [
  binaryUseSchema,
  websiteUseSchema,
  z
    .object({
      type: z.literal("files"),
      paths: z.array(inputPathSchema).min(1).max(32).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("npm-cli"),
      package: inputPathSchema,
      install: z.enum(["environment", "workspace"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("npm-package"),
      package: inputPathSchema,
      install: z.enum(["environment", "workspace"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("skill"),
      root: z
        .union([z.literal("."), inputPathSchema])
        .refine(
          (path) => !/[*?{}[\]]/.test(path),
          "Skill root must be an explicit directory",
        ),
    })
    .strict(),
]);
export const inputSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("git"),
      paths: z.array(inputPathSchema).min(1).max(32),
    })
    .strict(),
  z
    .object({
      type: z.literal("github-actions"),
      artifact: z.string().min(1).max(256).optional(),
    })
    .strict(),
]);
export const runPlanResourceSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(64),
    type: z.literal("input"),
    source: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("upload"),
          sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          bytes: z
            .number()
            .int()
            .positive()
            .max(512 * 1024 * 1024),
          repoUrl: z.string().nullable(),
          commit: z
            .string()
            .regex(/^[a-f0-9]{40}$/i)
            .nullable(),
        })
        .strict(),
      commentSourceSchema
        .extend({
          repoUrl: z.string(),
          commit: z.string().regex(/^[a-f0-9]{40}$/i),
        })
        .strict(),
      deploymentSourceSchema
        .extend({
          repoUrl: z.string(),
          commit: z.string().regex(/^[a-f0-9]{40}$/i),
        })
        .strict(),
      inputSourceSchema.options[0]
        .extend({
          repoUrl: z.string(),
          commit: z.string().regex(/^[a-f0-9]{40}$/i),
        })
        .strict(),
      inputSourceSchema.options[1]
        .extend({
          repoUrl: z.string(),
          commit: z.string().regex(/^[a-f0-9]{40}$/i),
          workflow: inputPathSchema,
        })
        .strict(),
    ]),
    use: inputUseSchema,
  })
  .strict()
  .refine(
    (r) =>
      (r.use.type === "website") ===
      (r.source.type === "github-deployment" ||
        r.source.type === "github-pr-comment"),
    "Website inputs require a deployment or PR comment source; file inputs require Git, Actions, or an upload",
  );
export type RunPlanResource = z.infer<typeof runPlanResourceSchema>;
