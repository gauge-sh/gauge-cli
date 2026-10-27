// The one home for web page URL rules. Two runtimes cannot import this file and
// keep mirrors: src/egress/web_fixtures.py and src/harness/web-injection-proxy.mjs.
// web-page-identity.test.ts runs all three on the same URLs.

/** Canonical request URL used by fixture storage, matching, and telemetry. A
 *  final slash names the same page, so /pricing and /pricing/ are one URL. */
export function normalizeWebFixtureUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

/** Request URLs that normalize to this page, as the egress gateway digests them. */
export function webPageVariants(raw: string): string[] {
  const href = normalizeWebFixtureUrl(raw);
  const url = new URL(href);
  if (url.pathname === "/") return [href];
  url.pathname = `${url.pathname}/`;
  return [href, url.href];
}
