import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { compileDefinitionInput } from "./runDefinitionInputs";
import {
  type RunDefinitionSubmission,
  runDefinitionFileConfigSchema,
  runDefinitionFrontmatterSchema,
  runDefinitionSubmissionSchema,
  uncredentialedRepoUrlSchema,
} from "./runDefinitions";

function utf8(bytes: Buffer, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${path} is not UTF-8 text`);
  }
}

export function parseRunDefinitionCase(path: string, bytes: Buffer) {
  const source = utf8(bytes, path);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match)
    throw new Error(`${path}: expected YAML frontmatter between --- lines`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length)
    throw new Error(
      `${path}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  const parsed = runDefinitionFrontmatterSchema.safeParse(document.toJS());
  if (!parsed.success) throw new Error(`${path}: ${parsed.error.message}`);
  const prompt = match[2].trim();
  if (!prompt) throw new Error(`${path}: Markdown body is empty`);
  return { path, prompt, ...parsed.data };
}

export function compileRunDefinitionFromBlobs(input: {
  repoUrl: string | null;
  commit: string | null;
  resources?: RunDefinitionSubmission["resources"];
  casePaths: readonly string[];
  blobs: ReadonlyMap<string, Buffer>;
  verification: "SUBMITTED_UNVERIFIED" | "GITHUB_VERIFIED" | "LOCAL";
}): {
  definition: RunDefinitionSubmission;
  org?: string;
} {
  if (
    input.repoUrl !== null &&
    !uncredentialedRepoUrlSchema.safeParse(input.repoUrl).success
  )
    throw new Error("Git origin must not contain embedded credentials");
  if (input.commit !== null && !/^[a-f0-9]{40}$/i.test(input.commit))
    throw new Error("Expected a full Git commit SHA");
  if (input.casePaths.length === 0)
    throw new Error("At least one Markdown case is required");
  if (new Set(input.casePaths).size !== input.casePaths.length)
    throw new Error("Case paths must be unique");

  const configBytes = input.blobs.get("gauge.json");
  let config:
    | ReturnType<typeof runDefinitionFileConfigSchema.parse>
    | undefined;
  if (configBytes) {
    try {
      config = runDefinitionFileConfigSchema.parse(
        JSON.parse(utf8(configBytes, "gauge.json")),
      );
    } catch (error) {
      throw new Error(
        `gauge.json: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  const cases = input.casePaths.map((path) => {
    const bytes = input.blobs.get(path);
    if (!path.endsWith(".md") || !bytes)
      throw new Error(`Missing Markdown case: ${path}`);
    return parseRunDefinitionCase(path, bytes);
  });
  const hash = createHash("sha256");
  hash.update("gauge-run-definition-v2\0");
  for (const [path, bytes] of [...input.blobs.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  const submission = runDefinitionSubmissionSchema.parse({
    version: 2,
    source: {
      repoUrl: input.repoUrl,
      commit: input.commit,
      digest: `sha256:${hash.digest("hex")}`,
      verification: input.verification,
    },
    resources:
      input.resources ??
      Object.entries(config?.inputs ?? {}).map(([name, item]) => {
        if (!input.repoUrl || !input.commit)
          throw new Error(
            `Supply --input ${name}=<path> outside a Git checkout with an origin`,
          );
        return compileDefinitionInput(name, item, input.repoUrl, input.commit);
      }),
    cases,
  });
  return { definition: submission, org: config?.orgId ?? config?.org };
}
