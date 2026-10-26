export function normalizeWebFixtureUrl(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  return url.href;
}

export function webPageKey(raw: string): string {
  const url = new URL(raw);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.host.replace(/^www\./, "")}${path}${url.search}`;
}

export function webPageHosts(raw: string): string[] {
  const apex = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  return /\.[a-z][a-z0-9-]*$/.test(apex) ? [apex, `www.${apex}`] : [apex];
}

export function webPageVariants(raw: string): string[] {
  const url = new URL(normalizeWebFixtureUrl(raw));
  const port = url.port ? `:${url.port}` : "";
  const path = url.pathname.replace(/\/+$/, "");
  const paths = path ? [path, `${path}/`] : ["/"];
  return webPageHosts(url.href).flatMap((host) =>
    paths.map(
      (variant) => `${url.protocol}//${host}${port}${variant}${url.search}`,
    ),
  );
}
