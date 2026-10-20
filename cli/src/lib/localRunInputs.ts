import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, globSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  compileRunDefinitionFromBlobs,
  parseRunDefinitionCase,
} from "@withgauge/api-schemas/compileRunDefinition";
import { matchInputPaths } from "@withgauge/api-schemas/inputPaths";
import {
  compileDefinitionInput,
  isSkillArchive,
} from "@withgauge/api-schemas/runDefinitionInputs";
import {
  type InputUploadResponse,
  type InputUploadSpec,
  type RunDefinitionSubmission,
  runDefinitionSubmissionSchema,
  runDefinitionFileConfigSchema,
  uncredentialedRepoUrlSchema,
} from "@withgauge/api-schemas/runDefinitions";
import {
  inputPathSchema,
  type RunPlanResource,
} from "@withgauge/api-schemas/runPlan";
import { create as tar } from "tar";
import { type CaseSpec, caseSpecCases, caseSpecDigest } from "./caseSpec";
import { type ApiClient, CliError } from "./client";
import { noCasesError } from "./docs";
import {
  read,
  rootDirectory,
  skippedInputEntry,
  workingFiles,
} from "./verifyEvals";

const LIMIT = 512 * 1024 * 1024;
type LocalUpload = InputUploadSpec & { path: string };

export type InputSnapshot = {
  name: string;
  source: "working-tree" | "override";
  path: string;
  gaugeArchive: { sha256: string; bytes: number };
};

export function parseInputOverrides(values: string[]): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const value of values) {
    const split = value.indexOf("=");
    const name = value.slice(0, split);
    const path = value.slice(split + 1);
    if (split < 1 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !path)
      throw new CliError("usage", "--input expects name=path");
    if (overrides.has(name))
      throw new CliError("usage", `Duplicate --input: ${name}`);
    overrides.set(name, path);
  }
  return overrides;
}

export async function packLocalInput(
  resource: RunPlanResource,
  supplied: string,
  output: string,
): Promise<{ use: RunPlanResource["use"]; upload: LocalUpload }> {
  if (resource.use.type === "website")
    throw new CliError(
      "usage",
      `Input ${resource.name}: website inputs cannot be supplied through --input.`,
      {
        hint: "Use the configured public preview with --hosted. For content-only alternatives and their discovery limits, read `gauge instructions hillclimb`.",
      },
    );
  const path = resolve(supplied);
  const info = await lstat(path).catch(() => {
    throw new CliError("usage", `Input path does not exist: ${supplied}`, {
      hint: "Pass --input <name>=<path>, or fix the input's path in gauge.json.",
    });
  });
  if (!info.isFile() && !info.isDirectory())
    throw new CliError(
      "usage",
      `Input must be an ordinary file or directory: ${supplied}`,
    );
  let use = resource.use;
  if (use.type === "skill") {
    if (info.isFile() && !isSkillArchive(path))
      throw new CliError(
        "usage",
        "Supply a Skill directory, .zip, or .tar.gz archive",
      );
    use = { ...use, root: info.isDirectory() ? "." : basename(path) };
  } else if (use.type === "npm-package" || use.type === "npm-cli") {
    if (!info.isFile() || !path.endsWith(".tgz"))
      throw new CliError("usage", "Supply the packed npm .tgz file");
    use = { ...use, package: basename(path) };
  } else if (!info.isDirectory())
    throw new CliError("usage", "Files and binary inputs require a directory");
  const root = info.isDirectory() ? path : dirname(path);
  const paths: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(join(root, directory), {
      withFileTypes: true,
    })) {
      if (skippedInputEntry(entry.name)) continue;
      const next = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
        throw new CliError(
          "usage",
          `Input contains a link or special file: ${next}`,
        );
      if (entry.isDirectory()) await walk(next);
      else paths.push(next);
      if (paths.length > 20_000)
        throw new CliError("usage", "Input exceeds 20,000 files");
    }
  };
  if (info.isDirectory()) await walk("");
  else paths.push(basename(path));
  const selected =
    (use.type === "files" || use.type === "binary") && use.paths
      ? matchInputPaths(paths, use.paths)
      : paths.sort();
  if (!selected.length)
    throw new CliError("usage", "Input contains no selected files");
  if (
    use.type === "skill" &&
    info.isDirectory() &&
    !selected.includes("SKILL.md")
  )
    throw new CliError(
      "usage",
      "Skill directory must contain SKILL.md at its root",
    );
  let total = 0;
  for (const file of selected) {
    inputPathSchema.parse(file);
    const entry = await lstat(join(root, file));
    if (!entry.isFile())
      throw new CliError(
        "usage",
        `Input file changed or is not an ordinary file: ${file}`,
      );
    total += entry.size;
    if (total > LIMIT) throw new CliError("usage", "Input exceeds 512 MiB");
  }
  await tar(
    {
      cwd: root,
      file: output,
      gzip: true,
      portable: true,
      noMtime: true,
      follow: false,
      noDirRecurse: true,
    },
    selected.map((file) => `./${file}`),
  );
  const bytes = (await stat(output)).size;
  if (bytes > LIMIT)
    throw new CliError("usage", "Input archive exceeds 512 MiB");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(output)) hash.update(chunk);
  return {
    use,
    upload: { path: output, bytes, sha256: `sha256:${hash.digest("hex")}` },
  };
}

export async function loadLocalRunDefinition(
  files: string[],
  values: string[],
  cwd = process.cwd(),
  { local = false, spec }: { local?: boolean; spec?: CaseSpec } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "gauge-inputs-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const root = rootDirectory(cwd);
    const paths = workingFiles(root);
    const blobs = new Map<string, Buffer>();
    if (paths.includes("gauge.json"))
      blobs.set("gauge.json", read(root, "gauge.json"));
    const configBytes = blobs.get("gauge.json");
    let config: ReturnType<typeof runDefinitionFileConfigSchema.parse>;
    try {
      config = runDefinitionFileConfigSchema.parse(
        configBytes ? JSON.parse(configBytes.toString("utf8")) : {},
      );
    } catch (error) {
      throw new CliError(
        "usage",
        `gauge.json is not valid: ${error instanceof Error ? error.message : error}`,
        { hint: "Run `gauge run --verify` for each problem." },
      );
    }
    const patterns = spec
      ? []
      : files.length
        ? files.map((file) => {
            const path = relative(root, resolve(cwd, file));
            if (
              !path ||
              path === ".." ||
              path.startsWith(`..${sep}`) ||
              isAbsolute(path)
            )
              throw new CliError(
                "usage",
                "Case paths must be inside the definition directory",
              );
            return path.split(sep).join("/");
          })
        : config.cases;
    const cases = spec
      ? []
      : files.length
        ? matchInputPaths(paths, patterns)
        : matchInputPaths(paths, patterns, { allowEmptySelection: true });
    if (!spec && cases.length === 0) throw noCasesError();
    if (cases.length > 20 || cases.some((path) => !path.endsWith(".md")))
      throw new CliError("usage", "Expected 1–20 Markdown cases");
    for (const path of cases) blobs.set(path, read(root, path));
    const parsed = spec
      ? caseSpecCases(spec)
      : cases.map((path) =>
          parseRunDefinitionCase(path, blobs.get(path) ?? Buffer.alloc(0)),
        );
    const unmeasured = parsed.filter(
      (item) => !item.criteria && !item.preference,
    );
    if (!local && unmeasured.length)
      throw new CliError(
        "usage",
        `Hosted cases need criteria or preference: ${unmeasured.map((item) => item.path).join(", ")}`,
        { hint: "Add criteria, or run locally with --local." },
      );
    for (const item of parsed)
      for (const name of item.config.inputs ?? [])
        if (!(name in config.inputs))
          throw new CliError(
            "usage",
            `${item.path}: unknown input "${name}". gauge.json defines: ${Object.keys(config.inputs).join(", ") || "none"}`,
          );
    const selected = new Set(
      parsed.flatMap(
        (item) => item.config.inputs ?? Object.keys(config.inputs),
      ),
    );
    const overrides = parseInputOverrides(values);
    for (const name of overrides.keys()) {
      if (!(name in config.inputs))
        throw new CliError("usage", `Unknown input: ${name}`);
      if (!selected.has(name))
        throw new CliError(
          "usage",
          `Input is not used by the selected cases: ${name}`,
        );
    }
    const git = (args: string[]) => {
      try {
        return execFileSync("git", args, {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        return null;
      }
    };
    const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const origin = git(["remote", "get-url", "origin"]);
    const repoUrl =
      origin && uncredentialedRepoUrlSchema.safeParse(origin).success
        ? origin
        : null;
    const resources: RunPlanResource[] = [];
    const uploads: LocalUpload[] = [];
    const inputSnapshots: InputSnapshot[] = [];
    for (const [name, input] of Object.entries(config.inputs)) {
      if (!selected.has(name)) continue;
      if (local && input.type === "website")
        throw new CliError(
          "usage",
          `Input ${name} is a website; canonical-site preview routing requires hosted Gauge.`,
          {
            hint: "Use --hosted with a public preview. Locally, supply docs as files or put a reachable preview URL in the prompt; these test supplied content, not discovery of the canonical site. See `gauge instructions hillclimb`.",
          },
        );
      const original = compileDefinitionInput(
        name,
        input,
        repoUrl ?? "",
        commit ?? "",
      );
      const supplied =
        overrides.get(name) ??
        (original.source.type === "git"
          ? workingTreeInput(root, name, input)
          : undefined);
      if (supplied !== undefined) {
        const { use, upload } = await packLocalInput(
          original,
          resolve(cwd, supplied),
          join(directory, `${name}.tar.gz`),
        );
        uploads.push(upload);
        inputSnapshots.push({
          name,
          source: overrides.has(name) ? "override" : "working-tree",
          path: resolve(cwd, supplied),
          gaugeArchive: { sha256: upload.sha256, bytes: upload.bytes },
        });
        resources.push({
          ...original,
          use,
          source: {
            type: "upload",
            sha256: upload.sha256,
            bytes: upload.bytes,
            repoUrl,
            commit,
          },
        });
      } else {
        if (local)
          throw new CliError(
            "usage",
            `Input ${name} has a remote source. Supply --input ${name}=<path> for local execution, or use --hosted.`,
          );
        if (!repoUrl || !commit)
          throw new CliError(
            "usage",
            `Input ${name}'s configured ${original.source.type} source requires a Git checkout with an origin.`,
            {
              hint: input.type === "website"
                ? "Configure the repository origin and publish a matching public preview through the declared source. Website inputs cannot use --input; see `gauge instructions hillclimb` for content-only alternatives."
                : `Supply --input ${name}=<path> to use local files.`,
            },
          );
        resources.push(original);
      }
    }
    if (!spec)
      return {
        ...compileRunDefinitionFromBlobs({
          repoUrl,
          commit,
          resources,
          blobs,
          casePaths: cases,
          verification: "LOCAL",
        }),
        uploads,
        inputSnapshots,
        cleanup,
      };
    const definition: RunDefinitionSubmission = {
      version: 2,
      source: {
        repoUrl,
        commit,
        digest: caseSpecDigest(spec),
        verification: "LOCAL",
      },
      resources,
      cases: parsed,
    };
    if (!local) runDefinitionSubmissionSchema.parse(definition);
    return { definition, org: config.org, uploads, inputSnapshots, cleanup };
  } catch (error) {
    await cleanup();
    if (error instanceof CliError || !(error instanceof Error)) throw error;
    throw new CliError("usage", error.message, {
      hint: "Check the case format in `gauge instructions run`, then run `gauge run --verify`.",
    });
  }
}

function workingTreeInput(
  root: string,
  name: string,
  input: ReturnType<
    typeof runDefinitionFileConfigSchema.parse
  >["inputs"][string],
): string {
  switch (input.type) {
    case "website":
      throw new CliError(
        "usage",
        `Input ${name} is a website; website inputs run on hosted Gauge only`,
      );
    case "files":
    case "binary":
      return root;
    case "skill":
      return join(root, input.path);
    case "npm-package": {
      const matches = globSync(input.path, { cwd: root });
      if (matches.length !== 1)
        throw new CliError(
          "usage",
          matches.length
            ? `Input ${name}: ${input.path} matches ${matches.length} files; keep one`
            : `Input ${name}: no file matches ${input.path}. Run \`npm pack\` first`,
        );
      return join(root, matches[0]);
    }
  }
}

export async function uploadLocalInputs(
  client: ApiClient,
  org: string,
  uploads: LocalUpload[],
) {
  for (const input of uploads) {
    const signed = await client.post<InputUploadResponse>(
      `/api/v1/orgs/${encodeURIComponent(org)}/run-definitions/uploads`,
      { sha256: input.sha256, bytes: input.bytes },
    );
    const signal = AbortSignal.timeout(10 * 60 * 1000);
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = createReadStream(input.path);
      let response: Response;
      try {
        response = await fetch(signed.url, {
          method: "PUT",
          headers: signed.headers,
          body,
          duplex: "half",
          redirect: "error",
          signal,
        } as RequestInit & { duplex: "half" });
      } finally {
        body.destroy();
      }
      await response.body?.cancel();
      if (response.ok || response.status === 412) break;
      if (response.status !== 409 || attempt === 2)
        throw new CliError(
          "network",
          `Input upload failed (${response.status})`,
        );
      await delay(100 * 2 ** attempt, undefined, { signal });
    }
  }
}
