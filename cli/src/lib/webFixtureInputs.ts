import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { list } from "tar";
import { MAX_WEB_FIXTURE_BYTES, mergeWebFixtures, parseWebFixtureInput, type WebFixture } from "@withgauge/api-schemas/web-fixtures";
import type { RunDefinitionSubmission } from "@withgauge/api-schemas/runDefinitions";

export type FrozenWebFixture = { fixture: WebFixture; digest: string };

/** Read a single bounded JSON member without extracting an archive onto the host. */
export async function readWebFixtureArchive(path: string, member: string, digest: string): Promise<WebFixture> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (`sha256:${hash.digest("hex")}` !== digest) throw new Error("Web fixture archive digest mismatch");
  const chunks: Buffer[] = [];
  let found = 0;
  let bytes = 0;
  let problem: Error | undefined;
  await list({ file: path, strict: true, onReadEntry(entry) {
    if (entry.path.replace(/^\.\//, "") !== member || entry.type !== "File" || entry.size > MAX_WEB_FIXTURE_BYTES) {
      problem = new Error("Web fixture archive must contain exactly its declared JSON file (at most 1 MB)");
      entry.resume();
      return;
    }
    found++;
    entry.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_WEB_FIXTURE_BYTES) problem = new Error("Web fixture exceeds 1 MB");
      else chunks.push(chunk);
    });
  } });
  if (problem) throw problem;
  if (found !== 1) throw new Error("Web fixture archive must contain exactly one JSON file");
  return parseWebFixtureInput(Buffer.concat(chunks).toString("utf8"));
}

export async function freezeWebFixtures(
  definition: RunDefinitionSubmission,
  archives: { path: string; sha256: string }[],
): Promise<Record<string, FrozenWebFixture>> {
  const inputs = new Map<string, WebFixture>();
  for (const resource of definition.resources) {
    if (resource.use.type !== "web-fixture") continue;
    if (resource.source.type !== "upload") throw new Error(`Web fixture ${resource.name} requires a local file`);
    const digest = resource.source.sha256;
    const archive = archives.find((a) => a.sha256 === digest);
    if (!archive) throw new Error(`Missing web fixture archive: ${resource.name}`);
    inputs.set(resource.name, await readWebFixtureArchive(archive.path, resource.use.path, archive.sha256));
  }
  const cases: Record<string, FrozenWebFixture> = {};
  for (const item of definition.cases) {
    const fixture = mergeWebFixtures((item.config.inputs ?? [...inputs.keys()]).flatMap((name) => inputs.get(name) ?? []));
    if (fixture) cases[item.path] = { fixture, digest: `sha256:${createHash("sha256").update(JSON.stringify(fixture)).digest("hex")}` };
  }
  return cases;
}
