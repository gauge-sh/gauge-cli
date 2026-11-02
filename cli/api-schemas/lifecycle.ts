import { z } from "zod";

export const DEFAULT_LIFECYCLE_TIMEOUT_SECONDS = 120;
export const MAX_LIFECYCLE_TIMEOUT_SECONDS = 600;
export const MAX_LIFECYCLE_SOURCE_LENGTH = 128 * 1024;

export const lifecycleScriptSchema = z
  .object({
    source: z.string().min(1).max(MAX_LIFECYCLE_SOURCE_LENGTH),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIFECYCLE_TIMEOUT_SECONDS)
      .default(DEFAULT_LIFECYCLE_TIMEOUT_SECONDS),
  })
  .strict();

/** Inline programs only. Source paths and shell commands are not authored hooks. */
export const lifecycleSchema = z
  .object({
    version: z.literal(1),
    setup: lifecycleScriptSchema.optional(),
    teardown: lifecycleScriptSchema.optional(),
    params: z.record(z.string().min(1).max(128), z.json()).default({}),
  })
  .strict()
  .refine(
    (value) => value.setup !== undefined || value.teardown !== undefined,
    {
      message: "Configure a setup or teardown script",
    },
  )
  .refine(
    (value) =>
      new TextEncoder().encode(JSON.stringify(value.params)).byteLength <=
      64 * 1024,
    {
      path: ["params"],
      message: "Lifecycle parameters must fit within 64 KiB",
    },
  );

export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type LifecycleInput = z.input<typeof lifecycleSchema>;
