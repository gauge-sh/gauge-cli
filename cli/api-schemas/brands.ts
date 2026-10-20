import { z } from "zod";
import { listQuerySchema, listResponseSchema } from "./common";

export const BRAND_KINDS = ["OWNED", "COMPETITOR", "OTHER"] as const;
export const brandKindSchema = z.enum(BRAND_KINDS);
export type BrandKind = z.infer<typeof brandKindSchema>;

export const BRAND_PACKAGE_ECOSYSTEMS = [
  "npm",
  "pypi",
  "cargo",
  "go",
  "rubygems",
  "other",
] as const;
export const brandPackageEcosystemSchema = z.enum(BRAND_PACKAGE_ECOSYSTEMS);

export const brandPackageSchema = z.object({
  name: z.string(),
  ecosystem: z.string().nullable(),
});
export type BrandPackage = z.infer<typeof brandPackageSchema>;

export const brandSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: brandKindSchema,
  source: z.string(),
  aliases: z.array(z.string()),
  websites: z.array(z.string()),
  category: z.string().nullable(),
  packages: z.array(brandPackageSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Brand = z.infer<typeof brandSchema>;

export const brandPackageInputSchema = z.object({
  name: z.string().min(1),
  ecosystem: brandPackageEcosystemSchema.nullable().optional(),
});
export type BrandPackageInput = z.infer<typeof brandPackageInputSchema>;

export const createBrandBodySchema = z.object({
  name: z.string().min(1),
  kind: brandKindSchema,
  aliases: z.array(z.string().min(1)).default([]),
  websites: z.array(z.string().min(1)).default([]),
  packages: z.array(brandPackageInputSchema).default([]),
});
export type CreateBrandBody = z.infer<typeof createBrandBodySchema>;

export const updateBrandBodySchema = z.object({
  name: z.string().min(1).optional(),
  kind: brandKindSchema.optional(),
  aliases: z.array(z.string().min(1)).optional(),
  websites: z.array(z.string().min(1)).optional(),
  packages: z.array(brandPackageInputSchema).optional(),
});
export type UpdateBrandBody = z.infer<typeof updateBrandBodySchema>;

export const listBrandsQuerySchema = listQuerySchema.extend({
  kind: brandKindSchema.optional(),
});
export type ListBrandsQuery = z.infer<typeof listBrandsQuerySchema>;

export const brandListResponseSchema = listResponseSchema(brandSchema);
