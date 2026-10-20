import { z } from "zod";

export const BRAND_KINDS = ["OWNED", "COMPETITOR", "OTHER"] as const;
export const brandKindSchema = z.enum(BRAND_KINDS);
export type BrandKind = z.infer<typeof brandKindSchema>;

export const brandRankingSchema = z.object({
  rank: z.number().int(),
  brandId: z.string(),
  brandName: z.string(),
  kind: brandKindSchema,
  installs: z.number().int(),
  installRate: z.number(),
  mentionRate: z.number(),
  deltaRank: z.number().int().nullable(),
});
export type BrandRanking = z.infer<typeof brandRankingSchema>;

export const packageRateSchema = z.object({
  ecosystem: z.string(),
  name: z.string(),
  brandName: z.string().optional(),
  kind: brandKindSchema.optional(),
  installs: z.number().int(),
  rate: z.number(),
});
export type PackageRate = z.infer<typeof packageRateSchema>;

export const brandRateSchema = z.object({
  brandId: z.string(),
  brandName: z.string(),
  kind: brandKindSchema,
  installs: z.number().int(),
  rate: z.number(),
});
export type BrandRate = z.infer<typeof brandRateSchema>;

export const brandFunnelRowSchema = z.object({
  brandId: z.string(),
  brandName: z.string(),
  kind: brandKindSchema,
  mentionRate: z.number(),
  installRate: z.number(),
});
export type BrandFunnelRow = z.infer<typeof brandFunnelRowSchema>;

export const domainRateSchema = z.object({
  domain: z.string(),
  runs: z.number().int(),
  rate: z.number(),
  requests: z.number().int(),
  brandName: z.string().optional(),
  owned: z.boolean().optional(),
});
export type DomainRate = z.infer<typeof domainRateSchema>;

export const statsFreshnessSchema = z.object({
  watermark: z.string().nullable(),
  pending: z.number().int(),
  available: z.boolean(),
});
export type StatsFreshness = z.infer<typeof statsFreshnessSchema>;

export const statsResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), freshness: statsFreshnessSchema });

export const rankingsResponseSchema = statsResponseSchema(brandRankingSchema);
export type RankingsResponse = z.infer<typeof rankingsResponseSchema>;

export const installsResponseSchema = statsResponseSchema(packageRateSchema);
export type InstallsResponse = z.infer<typeof installsResponseSchema>;

export const brandsResponseSchema = statsResponseSchema(brandRateSchema);
export type BrandsResponse = z.infer<typeof brandsResponseSchema>;

export const funnelResponseSchema = statsResponseSchema(brandFunnelRowSchema);
export type FunnelResponse = z.infer<typeof funnelResponseSchema>;

export const domainsResponseSchema = statsResponseSchema(domainRateSchema);
export type DomainsResponse = z.infer<typeof domainsResponseSchema>;
