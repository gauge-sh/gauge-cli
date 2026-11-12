import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import type { RunDefinitionSubmission } from "@withgauge/api-schemas/runDefinitions";
import { validateGatewayConnections, type GatewayConnection } from "@withgauge/local-execution";
import { CliError } from "./client";

/** Safe to persist: only environment variable names, never their values. */
export type LocalConnection = Omit<GatewayConnection, "value"> & { env: string };
export type ConnectionPlan = Record<string, LocalConnection[]>;

function fail(message: string): never { throw new CliError("usage", message); }
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function parseLocalConnections(source: string): LocalConnection[] {
  if (Buffer.byteLength(source) > 64 * 1024) fail("Local connections YAML exceeds 64 KiB.");
  // YAML diagnostics can quote source lines, which may contain an accidentally
  // pasted credential. Never print parser errors or arbitrary field values.
  let value: unknown;
  try {
    const document = parseDocument(source, { uniqueKeys: true, logLevel: "silent" });
    if (document.errors.length || document.warnings.length) fail("Invalid local connections YAML.");
    value = document.toJS({ maxAliasCount: 0 });
  } catch { fail("Invalid local connections YAML."); }
  if (!object(value) || Object.keys(value).some((key) => !["version", "connections"].includes(key)) ||
      value.version !== 1 || !Array.isArray(value.connections) || value.connections.length > 32)
    fail("Expected local connections YAML with version: 1 and a connections list (at most 32).");
  const connections: LocalConnection[] = [];
  const names = new Set<string>();
  for (const entry of value.connections) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "env,header,name,origin" ||
        ![entry.name, entry.origin, entry.header, entry.env].every((item) => typeof item === "string") ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.env as string))
      fail("Each local connection requires name, origin, header, and env (an environment variable name). Inline secrets are not supported.");
    if (names.has(entry.name as string)) fail("Duplicate local connection name.");
    names.add(entry.name as string);
    connections.push(entry as LocalConnection);
  }
  try {
    const validated = connections.map(({ env: _, ...entry }) => validateGatewayConnections([{ ...entry, value: "validation-placeholder" }])[0]);
    return connections.map((entry, index) => ({ ...entry, origin: validated[index].origin }));
  } catch { return fail("Invalid local connection name, HTTPS origin, or header. Use a DNS hostname on HTTPS port 443 without a path, query, fragment, credentials, or IP address, and an authentication header."); }
}

export async function loadConnectionPlan(definition: RunDefinitionSubmission, path: string): Promise<ConnectionPlan> {
  const selected = definition.cases.flatMap((item) => item.config.connectionIds ?? []);
  if (!selected.length) return {};
  let source: string;
  try { source = await readFile(path, "utf8"); }
  catch { return fail("Could not read local connections YAML. Create .gauge/connections.yaml or pass --connections-file <path>."); }
  const registry = new Map(parseLocalConnections(source).map((connection) => [connection.name, connection]));
  return Object.fromEntries(definition.cases.map((item) => {
    const names = item.config.connectionIds ?? [];
    if (new Set(names).size !== names.length) fail(`${item.path}: duplicate local connection selection.`);
    const connections = names.map((name) => {
      const connection = registry.get(name);
      if (!connection) fail(`${item.path}: local connection ${JSON.stringify(name)} is not configured.`);
      return connection!;
    });
    try { validateGatewayConnections(connections.map(({ env: _, ...entry }) => ({ ...entry, value: "validation-placeholder" }))); }
    catch { fail(`${item.path}: selected local connections conflict on a destination/header.`); }
    return [item.path, connections];
  }));
}

export function resolveLocalConnections(connections: LocalConnection[], env: NodeJS.ProcessEnv = process.env): GatewayConnection[] {
  const resolved = connections.map(({ env: variable, ...entry }) => {
    const value = env[variable];
    if (!value) fail(`Local connection ${entry.name}: environment variable ${variable} is missing or empty.`);
    return { ...entry, value: value! };
  });
  try { return validateGatewayConnections(resolved); }
  catch { return fail("Invalid local connection header value. Use a complete nonempty header value without control characters."); }
}

export function inspectLocalConnections(plan: ConnectionPlan) {
  const connections = [...new Map(Object.values(plan).flat().map((connection) => [connection.name, connection])).values()];
  return connections.map((connection) => {
    try { resolveLocalConnections([connection]); return { ...connection, ready: true as const }; }
    catch (error) { return { ...connection, ready: false as const, problem: (error as Error).message }; }
  });
}
