import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DockerCli } from "./docker.js";
import type { LaunchRecord, SessionSpec } from "./types.js";

export function validateGateway(gateway: NonNullable<SessionSpec["gateway"]>): void {
  const body = JSON.stringify(gateway.fixture);
  if (!gateway.image || Buffer.byteLength(body) > 1_000_000 || gateway.fixture.version !== 1 || gateway.fixture.searches.length)
    throw new Error("Invalid gateway fixture configuration");
  if (gateway.digest !== `sha256:${createHash("sha256").update(body).digest("hex")}`)
    throw new Error("Gateway fixture digest mismatch");
}

const CA_PATH = "/etc/ssl/certs/ca-certificates.crt";
const CA_VARIABLES = ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "PIP_CERT", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE", "GRPC_DEFAULT_SSL_ROOTS_FILE_PATH", "CARGO_HTTP_CAINFO", "DENO_CERT"];

/** Only the session worker calls this. Every possible resource name was journaled first. */
export async function prepareGateway(launch: LaunchRecord, canceled: () => boolean, docker = new DockerCli()): Promise<void> {
  const gateway = launch.spec.gateway!;
  validateGateway(gateway);
  const check = () => { if (canceled()) throw new Error("Session canceled during gateway preparation"); };
  const name = launch.gatewayName!;
  const labels = { "sh.gauge.session": launch.containerName };
  const fixturePath = join(launch.credentialDir, "fixture.json");
  await writeFile(fixturePath, JSON.stringify(gateway.fixture), { mode: 0o644 });
  check();
  if (await docker.create({ name, image: gateway.image, gateway: true,
    labels: { ...labels, "sh.gauge.role": "gateway" },
    mounts: [{ type: "bind", source: fixturePath, target: "/gateway/fixture.json", readonly: true }],
    env: {}, command: [] }) !== "created") throw new Error("Gateway container already exists");
  check();
  await docker.start(name);
  const deadline = Date.now() + 30_000;
  while (!await docker.ready(name)) {
    check();
    if (!await docker.running(name) || Date.now() >= deadline) throw new Error("Gateway did not become ready; see gateway.log");
    await delay(200);
  }
  check();
  const cert = join(launch.credentialDir, "gateway.crt");
  await docker.copy(name, "/gateway/private/mitmproxy-ca-cert.pem", cert);
  // A stopped, networkless container exposes the selected image's existing trust
  // store. It never executes code and has no credentials or workload mounts.
  const trust = launch.trustContainerName!;
  if (await docker.create({ name: trust, image: launch.spec.image, network: "none",
    labels: { ...labels, "sh.gauge.role": "trust" }, mounts: [], env: {}, command: ["true"] }) !== "created")
    throw new Error("Trust source container already exists");
  check();
  const bundle = join(launch.credentialDir, "ca-bundle.pem");
  await docker.copy(trust, CA_PATH, bundle);
  const original = await readFile(bundle, "utf8");
  const publicCA = await readFile(cert, "utf8");
  if (!original.includes("BEGIN CERTIFICATE") || !publicCA.includes("BEGIN CERTIFICATE") || publicCA.includes("PRIVATE KEY"))
    throw new Error("Gateway requires a PEM system trust store and a public CA certificate");
  await writeFile(bundle, `${original}\n${publicCA}`);
  await chmod(bundle, 0o644);
  await chmod(cert, 0o644);
  await docker.remove(trust);
  check();
  const workload = launch.workload!;
  workload.network = `container:${name}`;
  workload.restricted = true;
  workload.mounts.push(
    { type: "bind", source: bundle, target: CA_PATH, readonly: true },
    { type: "bind", source: cert, target: "/gauge/certs/gateway.crt", readonly: true },
  );
  workload.env.NODE_EXTRA_CA_CERTS = "/gauge/certs/gateway.crt";
  for (const variable of CA_VARIABLES) workload.env[variable] = CA_PATH;
}

export async function cleanupGateway(launch: LaunchRecord, directory: string, docker = new DockerCli()): Promise<void> {
  if (!launch.gatewayName) return;
  await docker.assertCompanionOwner(launch.gatewayName, launch.containerName, "gateway");
  await docker.stop(launch.gatewayName, 2);
  try { await writeFile(join(directory, "gateway.log"), await docker.logs(launch.gatewayName), { mode: 0o600 }); }
  catch { /* A create failure may leave no container or logs. Cleanup still proceeds. */ }
  await docker.remove(launch.gatewayName);
  await docker.assertCompanionOwner(launch.trustContainerName!, launch.containerName, "trust");
  await docker.remove(launch.trustContainerName!);
}
