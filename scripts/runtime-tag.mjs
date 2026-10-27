import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function runtimeTagExists(manifest, { actor, token, tag = manifest.version, fetchImpl = fetch }) {
  const name = manifest.repository.replace(/^ghcr.io\//, "");
  const tokenResponse = await fetchImpl(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull,push`, {
    headers: { authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString("base64")}` },
  });
  if (!tokenResponse.ok) throw new Error(`GHCR authentication failed (${tokenResponse.status})`);
  const { token: registryToken } = await tokenResponse.json();
  if (!registryToken) throw new Error("GHCR did not return a registry token");
  const response = await fetchImpl(`https://ghcr.io/v2/${name}/manifests/${encodeURIComponent(tag)}`, {
    headers: {
      authorization: `Bearer ${registryToken}`,
      accept: "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json",
    },
  });
  if (response.status !== 200 && response.status !== 404) throw new Error(`Cannot establish runtime tag availability (${response.status})`);
  return response.status === 200;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const manifest = JSON.parse(await readFile(new URL(process.argv.includes("--gateway") ? "../cli/gateway-manifest.json" : "../cli/runtime-manifest.json", import.meta.url), "utf8"));
  console.log(`exists=${await runtimeTagExists(manifest, { actor: process.env.GITHUB_ACTOR, token: process.env.GHCR_TOKEN, tag: process.argv[2] ?? manifest.version })}`);
}
