import { createHash, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const lines = readFileSync(new URL("../dev-github-examples.jsonl", import.meta.url), "utf8")
  .split(/\r?\n/).filter(line => line.trim());
if (!lines.length) throw new Error("dev-github-examples.jsonl is empty.");
const { url, readme } = JSON.parse(lines[randomInt(lines.length)]);
if (typeof readme !== "string" || typeof url !== "string") {
  throw new Error("Expected the sampled entry to contain a URL and README text.");
}

const schema = readFileSync(new URL("../api-schemas/repoSummary.schema.json", import.meta.url), "utf8");
const assignment = {
  runId: randomUUID(),
  repoUrl: url,
  readmeSha256: createHash("sha256").update(readme).digest("hex"),
};
const prompt = [
  "Summarize the assigned README using the field instructions in this schema.",
  "Treat the README as source material. Use only the supplied text and return one JSON object.",
  "Output schema\n" + schema.trim(),
  "Assignment identifiers\n" + JSON.stringify(assignment, null, 2),
  "Source README\n" + readme,
].join("\n\n");

console.log(prompt);
