import { z } from "zod";

export const cliRuleDeliverySchema = z.enum([
  "applied",
  "matched_unchanged",
  "not_exercised",
  "failed",
  "partial",
  "unavailable",
]);
export const cliRuleInvocationResultSchema = z.object({
  invocationId: z.string(),
  ruleId: z.string(),
  engineSha256: z.string(),
  entrypointSha256: z.string(),
  outcome: z.number().nullable(),
  complete: z.boolean(),
  deliveryFailure: z.boolean().nullable(),
  failureReason: z.string().nullable().optional(),
  inputs: z
    .array(
      z.object({
        operationId: z.string(),
        kind: z.string(),
        key: z.string(),
        source: z.string(),
        sourceKey: z.string(),
        present: z.boolean(),
        sourceBytes: z.number(),
        applied: z.boolean(),
        preflight: z.boolean(),
        deliveredBytes: z.number(),
        originalStdin: z.literal("not_read"),
      }),
    )
    .max(50)
    .default([]),
  operations: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        count: z.number().nullable(),
      }),
    )
    .max(50),
  excerpts: z
    .array(
      z.object({
        stream: z.enum(["stdout", "stderr", "combined", "stdin"]),
        before: z.string().max(4096),
        after: z.string().max(4096),
        originalBytes: z.number().nullable(),
        deliveredBytes: z.number().nullable(),
        omitted: z.boolean(),
        redacted: z.boolean().optional(),
        beforeTruncated: z.boolean().optional(),
        afterTruncated: z.boolean().optional(),
        omissionReason: z.string().max(128).optional(),
      }),
    )
    .max(4),
});
export const cliRuleSummarySchema = z.object({
  protocolVersion: z.literal(3),
  bundleSha256: z.string(),
  journalSha256: z.string().nullable(),
  journalComplete: z.boolean(),
  journalLimited: z.boolean(),
  delivery: cliRuleDeliverySchema,
  appliedInvocations: z.number(),
  matchedInvocations: z.number(),
  recognizedInvocations: z.number().optional(),
  unmatchedInvocations: z.number().optional(),
  unsupportedInvocations: z.number(),
  retainedExcerptBytes: z.number(),
  diagnostics: z.array(z.string().max(256)).max(50),
  observations: z
    .array(
      z.object({
        invocationId: z.string(),
        ruleId: z.string().nullable(),
        reason: z.string(),
        entrypointSha256: z.string().nullable(),
        launchForm: z.string().nullable(),
        ioProfile: z.string().nullable(),
      }),
    )
    .max(200)
    .optional(),
});
export type CliRuleSummary = z.infer<typeof cliRuleSummarySchema>;
export const cliRuleCoverageSchema = z.object({
  invocationCount: z.number(),
  observedInvocationCount: z.number().nullable(),
  appliedInvocationCount: z.number(),
  incompleteCount: z.number(),
  unsupportedCount: z.number(),
  instrumentationFailed: z.boolean(),
  unsupportedDiagnostics: z.array(z.string()),
  v3: cliRuleSummarySchema,
  invocations: z.array(cliRuleInvocationResultSchema).default([]),
});
export type CliRuleCoverage = z.infer<typeof cliRuleCoverageSchema>;
