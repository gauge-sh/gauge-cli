import { z } from "zod";

export const API_VERSION_HEADER = "X-Gauge-Api-Version";

export const ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "invalid_request",
  "insufficient_credits",
  "needs_provider_key",
  "rate_limited",
  "conflict",
  "internal",
  "upgrade_required",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const upgradeOfferSchema = z.object({
  skuId: z.string(),
  tierLabel: z.string(),
  monthlyAmountCents: z.number().int(),
  monthlyCredits: z.number().int(),
  billingUrl: z.string(),
});
export type UpgradeOffer = z.infer<typeof upgradeOfferSchema>;

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    upgrade: upgradeOfferSchema.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export function makeErrorEnvelope(
  code: ErrorCode,
  message: string,
  upgrade?: UpgradeOffer,
): ErrorEnvelope {
  return { error: { code, message, ...(upgrade ? { upgrade } : {}) } };
}

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export function listResponseSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().optional(),
  });
}

export type ListResponse<T> = {
  items: T[];
  nextCursor?: string;
};

export function makeListResponse<T>(
  items: T[],
  nextCursor?: string,
): ListResponse<T> {
  return nextCursor === undefined ? { items } : { items, nextCursor };
}

export const createdBySchema = z
  .object({
    userId: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string().nullable(),
  })
  .nullable()
  .optional();
export type CreatedBy = z.infer<typeof createdBySchema>;
