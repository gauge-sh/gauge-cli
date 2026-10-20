import { z } from "zod";

export const websiteUrlSchema = z.url().refine((raw) => {
  const u = new URL(raw);
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.port &&
    !u.search &&
    !u.hash
  );
}, "Expected an HTTPS documentation URL without credentials, port, query or fragment");
export const websiteUseSchema = z
  .object({
    type: z.literal("website"),
    url: websiteUrlSchema.refine(
      (url) => new URL(url).pathname === "/",
      "Website inputs require an origin without a path",
    ),
  })
  .strict();
export const deploymentSourceSchema = z
  .object({
    type: z.literal("github-deployment"),
    environment: z.string().min(1).max(128),
  })
  .strict();
export const commentSourceSchema = z
  .object({
    type: z.literal("github-pr-comment"),
    author: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9-]+(?:\[bot\])?$/),
    bodyIncludes: z
      .string()
      .min(1)
      .max(256)
      .describe("Literal marker identifying the provider's preview comment."),
    pattern: z
      .string()
      .min(1)
      .max(2048)
      .refine((pattern) => {
        try {
          new RegExp(pattern, "gm");
          return pattern.includes("(?<url>") && pattern.includes("(?<sha>");
        } catch {
          return false;
        }
      }, "Use a valid regex with named url and sha captures; match only a ready preview")
      .describe(
        "JavaScript regex (gm flags) matching readiness and capturing url and sha (7–40 hex characters). Execution is time limited.",
      ),
    failureIncludes: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Literal failure marker in the selected comment; failure never falls back to older comments.",
      ),
  })
  .strict();
export const websiteSourceSchema = z.discriminatedUnion("type", [
  deploymentSourceSchema,
  commentSourceSchema,
]);
export function withinWebsiteScope(raw: string, base: string): boolean {
  const u = new URL(raw),
    scope = new URL(base);
  const prefix = scope.pathname.replace(/\/$/, "");
  return (
    u.origin === scope.origin &&
    (u.pathname === prefix || u.pathname.startsWith(`${prefix}/`))
  );
}
