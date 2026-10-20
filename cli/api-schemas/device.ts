import { z } from "zod";

export const deviceAuthorizeRequestSchema = z.object({
  deviceName: z.string().trim().max(64).optional(),
  email: z.string().trim().email().max(320).optional(),
});
export type DeviceAuthorizeRequest = z.infer<
  typeof deviceAuthorizeRequestSchema
>;

export const deviceAuthorizeResponseSchema = z.object({
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  verificationUriComplete: z.string(),
  interval: z.number().int().positive(),
  expiresIn: z.number().int().positive(),
  emailSent: z.boolean(),
});
export type DeviceAuthorizeResponse = z.infer<
  typeof deviceAuthorizeResponseSchema
>;

export const deviceTokenRequestSchema = z.object({
  deviceCode: z.string().min(1),
});
export type DeviceTokenRequest = z.infer<typeof deviceTokenRequestSchema>;

export const deviceTokenApprovedSchema = z.object({
  status: z.literal("approved"),
  accessToken: z.string(),
  tokenType: z.literal("bearer"),
  expiresAt: z.string().nullable(),
});

export const deviceTokenResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("slow_down"), interval: z.number().int() }),
  z.object({ status: z.literal("denied") }),
  z.object({ status: z.literal("expired") }),
  deviceTokenApprovedSchema,
]);
export type DeviceTokenResult = z.infer<typeof deviceTokenResultSchema>;
