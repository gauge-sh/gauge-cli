import { z } from "zod";
import { listQuerySchema, listResponseSchema } from "./common";

export const billingTierSchema = z.object({
  skuId: z.string(),
  tierLabel: z.string(),
  position: z.number().int(),
  monthlyAmountCents: z.number().int(),
  monthlyCredits: z.number().int(),
  baseCredits: z.number().int(),
  bonusCredits: z.number().int(),
  dollarsPerThousandCredits: z.number(),
});
export type BillingTier = z.infer<typeof billingTierSchema>;

export const billingCatalogSchema = z.object({
  catalogKey: z.string(),
  catalogLabel: z.string(),
  visibility: z.enum(["PUBLIC", "PRIVATE"]),
  tiers: z.array(billingTierSchema),
});
export type BillingCatalog = z.infer<typeof billingCatalogSchema>;

const workloadCreditStateSchema = <T extends z.ZodType>(value: T) =>
  z.object({
    eval: value,
    visibility: value,
    generic: value,
  });

export const billingStatusSchema = z.object({
  enforced: z.boolean(),
  balance: z.number(),
  allowance: z.number().nullable(),
  currentSku: billingTierSchema.nullable(),
  offeredCatalog: billingCatalogSchema.nullable(),
  nextTier: billingTierSchema.nullable(),
  subscriptionStatus: z.string().nullable(),
  currentPeriodStart: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  creditsUsedThisPeriod: z.number(),
  runsThisPeriod: z.number(),
  holdPerRun: z.number(),
  canRun: z.boolean(),
  holdsPerRun: workloadCreditStateSchema(z.number()),
  canRunByWorkload: workloadCreditStateSchema(z.boolean()),
  paymentType: z.enum(["invoice", "card"]).nullable().optional(),
  creditLine: z
    .object({ limitUsd: z.number(), usedUsd: z.number() })
    .nullable()
    .optional(),

  plan: z.string().nullable(),
  overageEnabled: z.boolean(),
  overageCapCredits: z.number().nullable(),
  overageThisPeriod: z.number(),
});
export type BillingStatus = z.infer<typeof billingStatusSchema>;

export const LEDGER_KINDS = [
  "SIGNUP_GRANT",
  "SUBSCRIPTION_GRANT",
  "UPGRADE_GRANT",
  "RENEWAL_GRANT",
  "RUN_DEBIT",
  "RUN_REFUND",
  "OVERAGE_DEBIT",
  "ADMIN_ADJUST",
  "EXPIRY",
  "CREDIT_LINE_SETTLE",
  "CREDIT_LINE_CARRY",
] as const;
export const ledgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof ledgerKindSchema>;

export const usageEntrySchema = z.object({
  id: z.string(),
  kind: ledgerKindSchema,
  delta: z.number().int(),
  runId: z.string().nullable(),
  batchId: z.string().nullable(),
  createdAt: z.string(),
});
export type UsageEntry = z.infer<typeof usageEntrySchema>;

export const usageQuerySchema = listQuerySchema.extend({
  since: z.string().optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

export const usageListResponseSchema = listResponseSchema(usageEntrySchema);
