import { z } from "zod";
import { dateRangeSchema, queryFiltersSchema, querySpecSchema } from "./query";

export const VIZ_TYPES = ["line", "bar", "table", "kpi"] as const;
export const vizTypeSchema = z.enum(VIZ_TYPES);
export type VizType = z.infer<typeof vizTypeSchema>;

export const widgetEncodingSchema = z
  .object({
    x: z.string(),
    series: z.string(),
    y: z.array(z.string()),
  })
  .partial();
export type WidgetEncoding = z.infer<typeof widgetEncodingSchema>;

export const preferenceSpecSchema = z.object({
  dataset: z.literal("preference"),
  report: z.enum([
    "ranking",
    "head_to_head",
    "recommended_over_time",
    "mentioned_over_time",
  ]),
});
export const widgetSpecSchema = z.union([
  querySpecSchema,
  preferenceSpecSchema,
]);

const widgetFields = {
  id: z.string().min(1),
  title: z.string(),
  viz: vizTypeSchema,
  spec: widgetSpecSchema,
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1),
  encoding: widgetEncodingSchema.optional(),
};

export const widgetSchema = z
  .object(widgetFields)
  .refine((w) => w.x + w.w <= 12, {
    message: "widget spills past the 12-column grid (x + w must be ≤ 12)",
  });
export type Widget = z.infer<typeof widgetSchema>;

export const widgetPatchSchema = z.object(widgetFields).partial();
export type WidgetPatch = z.infer<typeof widgetPatchSchema>;

export const dashboardFiltersSchema = z
  .object({
    filters: queryFiltersSchema,
    dateRange: dateRangeSchema,
  })
  .partial();
export type DashboardFilters = z.infer<typeof dashboardFiltersSchema>;

export const overlayPatchSchema = z
  .object({
    name: z.string(),
    defaultFilters: dashboardFiltersSchema,
    widgets: z.record(z.string(), widgetPatchSchema.nullable()),
    order: z.array(z.string()),
  })
  .partial();
export type OverlayPatch = z.infer<typeof overlayPatchSchema>;

export const resolvedDashboardSchema = z.object({
  key: z.string(),
  name: z.string(),
  widgets: z.array(widgetSchema),
  defaultFilters: dashboardFiltersSchema,
  hasOrgOverlay: z.boolean(),
  hasUserOverlay: z.boolean(),
});
export type ResolvedDashboard = z.infer<typeof resolvedDashboardSchema>;

export const dashboardTemplateSchema = z.object({
  key: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  widgets: z.array(widgetSchema),
  defaultFilters: dashboardFiltersSchema.optional(),
});
export type DashboardTemplate = z.infer<typeof dashboardTemplateSchema>;
export type DashboardTemplateInput = z.input<typeof dashboardTemplateSchema>;

export const dashboardSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  source: z.enum(["template", "org", "user"]),
  isUserDefault: z.boolean(),
  isOrgDefault: z.boolean(),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export const listDashboardsResponseSchema = z.object({
  items: z.array(dashboardSummarySchema),
});
export type ListDashboardsResponse = z.infer<
  typeof listDashboardsResponseSchema
>;

export const createDashboardBodySchema = z.object({
  name: z.string().min(1).max(120),
  widgets: z.array(widgetSchema).optional(),
});
export type CreateDashboardBody = z.infer<typeof createDashboardBodySchema>;
export type CreateDashboardBodyInput = z.input<
  typeof createDashboardBodySchema
>;

export const updateDashboardBodySchema = z.object({
  name: z.string().min(1).max(120),
});
export type UpdateDashboardBody = z.infer<typeof updateDashboardBodySchema>;
