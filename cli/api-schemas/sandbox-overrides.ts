import { z } from "zod";

export const SANDBOX_OVERRIDE_KINDS = ["packages", "clis"] as const;
export type SandboxOverrideKind = (typeof SANDBOX_OVERRIDE_KINDS)[number];
export const ecosystemSchema = z.enum(["npm", "pypi", "cargo", "go", "gem"]);
export const overrideFilesSchema = z
  .array(
    z
      .object({
        path: z
          .string()
          .min(1)
          .refine(
            (path) =>
              !path.startsWith("/") &&
              !path.includes("\\") &&
              !path.split("/").includes(".."),
            "Use a relative path within the target",
          ),
        body: z.string(),
      })
      .strict(),
  )
  .min(1);

const contentShape = {
  version: z.string().trim().min(1).optional(),
  files: overrideFilesSchema.optional(),
};
const hasContent = (value: { version?: string; files?: unknown[] }) =>
  value.version !== undefined || value.files !== undefined;

export const sandboxOverridesSchema = z
  .object({
    version: z.literal(1),
    packages: z
      .array(
        z
          .object({
            ecosystem: ecosystemSchema,
            name: z.string().trim().min(1),
            ...contentShape,
          })
          .strict()
          .refine(hasContent, "Specify a version or files"),
      )
      .optional(),
    clis: z
      .array(
        z
          .object({
            name: z.string().trim().min(1),
            ...contentShape,
          })
          .strict()
          .refine(hasContent, "Specify a version or files"),
      )
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const identities: Record<SandboxOverrideKind, string[]> = {
      packages: (value.packages ?? []).map((entry) =>
        JSON.stringify([entry.ecosystem, entry.name]),
      ),
      clis: (value.clis ?? []).map((entry) => entry.name),
    };
    for (const kind of SANDBOX_OVERRIDE_KINDS) {
      if (new Set(identities[kind]).size !== identities[kind].length)
        ctx.addIssue({
          code: "custom",
          path: [kind],
          message: "Duplicate override identity",
        });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength >= 1_000_000)
      ctx.addIssue({
        code: "custom",
        message: "Sandbox overrides must be under 1 MB",
      });
  });
export type SandboxOverrides = z.infer<typeof sandboxOverridesSchema>;
