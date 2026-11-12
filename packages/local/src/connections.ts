import { isIP } from "node:net";

/** Resolved credentials stay in host memory and the gateway-only temporary file. */
export interface GatewayConnection {
  name: string;
  origin: string;
  header: string;
  value: string;
}

const FORBIDDEN_HEADERS = new Set([
  "host", "connection", "proxy-connection", "keep-alive", "transfer-encoding",
  "te", "trailer", "upgrade", "content-length", "expect", "proxy-authorization",
  "proxy-authenticate", "forwarded", "via", "x-forwarded-host", "x-forwarded-proto",
  "x-forwarded-port", "x-forwarded-for",
]);

/** Errors deliberately omit input text, which may contain a credential. */
export function validateGatewayConnections(connections: GatewayConnection[]): GatewayConnection[] {
  if (!Array.isArray(connections)) throw new Error("Invalid gateway connections");
  const names = new Set<string>();
  const targets = new Set<string>();
  return connections.map((connection) => {
    if (!connection || typeof connection.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(connection.name) || names.has(connection.name))
      throw new Error("Invalid or duplicate gateway connection name");
    if (typeof connection.origin !== "string" || !/^https:\/\/[^/?#\\\s]+\/?$/.test(connection.origin))
      throw new Error("Gateway connections require an HTTPS origin on port 443");
    let url: URL;
    try { url = new URL(connection.origin); } catch { throw new Error("Invalid gateway connection origin"); }
    const hostname = url.hostname;
    const validHost = hostname.startsWith("[")
      ? isIP(hostname.slice(1, -1)) === 6
      : hostname.length <= 253 && hostname.replace(/\.$/, "").split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label));
    if (isIP(hostname.replace(/^\[|\]$/g, ""))) throw new Error("Gateway connections require a DNS hostname with TLS SNI, not an IP address");
    if (!/^https:\/\/[A-Za-z0-9.:[\]-]+\/?$/.test(connection.origin) || /:\/?$/.test(connection.origin) || !validHost)
      throw new Error("Invalid gateway connection origin");
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || !url.hostname)
      throw new Error("Gateway connections require an HTTPS origin on port 443");
    if (typeof connection.header !== "string" || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(connection.header) || FORBIDDEN_HEADERS.has(connection.header.toLowerCase()) || connection.header.toLowerCase().startsWith("x-forwarded-"))
      throw new Error("Invalid gateway connection header");
    if (typeof connection.value !== "string" || !/^[\x20-\x7e]+$/.test(connection.value) || !connection.value.trim())
      throw new Error("Invalid gateway connection credential value");
    const target = `${url.origin}\n${connection.header.toLowerCase()}`;
    if (targets.has(target)) throw new Error("Duplicate gateway connection origin and header");
    names.add(connection.name);
    targets.add(target);
    return { name: connection.name, origin: url.origin, header: connection.header, value: connection.value };
  });
}

/** Do not pass resolved connection source variables to the detached worker. */
export function workerEnvironment(env: NodeJS.ProcessEnv, connectionEnvNames: string[] = []): NodeJS.ProcessEnv {
  const excluded = new Set(connectionEnvNames);
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !excluded.has(key) && !/(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN)$/.test(key)));
}
