import { z } from "zod";
import { websiteUrlSchema, withinWebsiteScope } from "./websiteInputs";

export const MAX_WEB_FIXTURE_BYTES = 1_000_000;

export function normalizeWebFixtureUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

const searchResultSchema = z.object({
  title: z.string().min(1),
  url: z.url().transform(normalizeWebFixtureUrl),
  snippet: z.string(),
});

const searchFixtureSchema = z.object({
  query: z.string().trim().min(1),
  results: z.array(searchResultSchema),
});

const pageFixtureSchema = z.object({
  url: z.url().transform(normalizeWebFixtureUrl),
  status: z.int().min(100).max(599).default(200),
  contentType: z.string().trim().min(1).default("text/html"),
  body: z.string(),
});

export const originProxySchema = z
  .object({
    origin: websiteUrlSchema
      .refine((raw) => new URL(raw).pathname === "/", "Expected an origin")
      .transform((raw) => new URL(raw).origin),
    upstream: websiteUrlSchema
      .refine((raw) => new URL(raw).pathname === "/", "Expected an origin")
      .transform((raw) => new URL(raw).origin),
  })
  .strict();

export const webFixtureSchema = z
  .object({
    version: z.literal(1),
    origins: z.array(originProxySchema).max(32).optional(),
    scopes: z
      .array(websiteUrlSchema.transform(normalizeWebFixtureUrl))
      .max(32)
      .optional(),
    searches: z.array(searchFixtureSchema).default([]),
    pages: z.array(pageFixtureSchema).default([]),
  })
  .superRefine((fixture, ctx) => {
    if (
      fixture.scopes?.some(
        (scope) =>
          !fixture.pages.some(
            (page) => new URL(page.url).origin === new URL(scope).origin,
          ),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["scopes"],
        message: "Each scope must have a captured page on its origin",
      });
    const origins = new Set<string>();
    for (const route of fixture.origins ?? []) {
      if (
        origins.has(route.origin) ||
        route.origin === route.upstream ||
        fixture.pages.some(
          (page) => new URL(page.url).origin === route.origin,
        ) ||
        fixture.scopes?.some((scope) => new URL(scope).origin === route.origin)
      )
        ctx.addIssue({
          code: "custom",
          message: "Origin proxy overlaps another fixture route",
        });
      origins.add(route.origin);
    }
    const queries = new Set<string>();
    fixture.searches.forEach((entry, index) => {
      if (queries.has(entry.query)) {
        ctx.addIssue({
          code: "custom",
          path: ["searches", index, "query"],
          message: `duplicate normalized query: ${entry.query}`,
        });
      }
      queries.add(entry.query);
    });

    const urls = new Set<string>();
    fixture.pages.forEach((entry, index) => {
      if (urls.has(entry.url)) {
        ctx.addIssue({
          code: "custom",
          path: ["pages", index, "url"],
          message: `duplicate normalized URL: ${entry.url}`,
        });
      }
      urls.add(entry.url);
    });

    const bytes = new TextEncoder().encode(JSON.stringify(fixture)).byteLength;
    if (bytes > MAX_WEB_FIXTURE_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `serialized fixture is ${bytes} bytes; maximum is ${MAX_WEB_FIXTURE_BYTES}`,
      });
    }
  });

export type WebFixture = z.infer<typeof webFixtureSchema>;

/** Portable gateway inputs deliberately exclude search mocks and body transforms. */
export const webFixtureInputSchema = webFixtureSchema.safeExtend({
  searches: z.array(z.never()).max(0).default([]),
  pages: z.array(pageFixtureSchema.safeExtend({
    url: z.url().refine((raw) => {
      const url = new URL(raw);
      return url.protocol === "https:" && !url.port && !url.username && !url.password;
    }, "Expected an HTTPS URL without credentials or a custom port").transform(normalizeWebFixtureUrl),
    status: z.int().min(200).max(599).default(200),
    contentType: z.string().trim().min(1).regex(/^[\x20-\x7e]+$/).default("text/html"),
    body: z.string().refine((body) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(body), "Body must be valid Unicode"),
  }).strict().refine((page) => ![204, 205, 304].includes(page.status) || page.body === "",
    "This HTTP status requires an empty body")).default([]),
}).strict().refine((fixture) => fixture.pages.length > 0 || (fixture.origins?.length ?? 0) > 0, "Web fixture must contain pages or origin mappings");

export function parseWebFixtureInput(text: string): WebFixture {
  if (new TextEncoder().encode(text).byteLength > MAX_WEB_FIXTURE_BYTES)
    throw new Error(`Web fixture exceeds ${MAX_WEB_FIXTURE_BYTES} bytes`);
  return webFixtureInputSchema.parse(JSON.parse(text));
}

/** Resolve all conflicts before any consumer starts; input order never wins. */
export function mergeWebFixtures(fixtures: readonly WebFixture[]): WebFixture | undefined {
  if (!fixtures.length) return undefined;
  const scopes: string[] = [];
  for (const [index, fixture] of fixtures.entries()) {
    for (const scope of fixture.scopes ?? []) {
      if (scopes.some((other) => withinWebsiteScope(scope, other) || withinWebsiteScope(other, scope)))
        throw new Error("Web fixture scopes overlap in this case");
      if (fixtures.some((other, otherIndex) => otherIndex !== index &&
        other.pages.some((page) => withinWebsiteScope(page.url, scope))))
        throw new Error("Web fixture scope overlaps another input's pages");
      scopes.push(scope);
    }
  }
  return webFixtureSchema.parse({
    version: 1, scopes,
    origins: fixtures.flatMap((f) => f.origins ?? []),
    searches: fixtures.flatMap((f) => f.searches),
    pages: fixtures.flatMap((f) => f.pages),
  });
}
