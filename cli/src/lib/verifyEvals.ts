import { findWorkspace } from "./gaugeState";
import { execFileSync } from "node:child_process";
import {
  globSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseRunDefinitionCase } from "@withgauge/api-schemas/compileRunDefinition";
import { matchInputPaths } from "@withgauge/api-schemas/inputPaths";
import {
  isSkillArchive,
  runDefinitionInputSchema,
} from "@withgauge/api-schemas/runDefinitionInputs";
import { runDefinitionFileConfigSchema } from "@withgauge/api-schemas/runDefinitions";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";
import type { z } from "zod";
import { readable } from "./errors";
import { CliError } from "./client";
import { assertLocalCapabilities } from "./localCapabilities";

export type VerificationState = "yes" | "no" | "unknown";
export type VerificationCheck = {
  id: string;
  state: VerificationState;
  detail: string;
};
export type EvalVerification = {
  version: 1;
  mode: "local-static";
  root: string;
  status: "passed" | "failed" | "incomplete";
  summary: { yes: number; no: number; unknown: number };
  facts: { configFilePresent: boolean | null; caseCount: number | null };
  info: { id: string; detail: string }[];
  notChecked: string[];
  global: VerificationCheck[];
  inputs: { name: string; checks: VerificationCheck[] }[];
};
type Input = z.infer<typeof runDefinitionInputSchema>;
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const message = (error: unknown) =>
  oneLine(
    error instanceof CliError && error.hint
      ? `${error.message} ${error.hint}`
      : error instanceof Error
        ? error.message
        : String(error),
  );
const oneLine = (text: string) => readable(text).trim().replace(/\n\s*/g, "; ");
const check = (
  id: string,
  state: VerificationState,
  detail: string,
): VerificationCheck => ({ id, state, detail });
const dynamic = (value: unknown) =>
  typeof value !== "string" || value.includes("${{");
const condition = (value: unknown): boolean | undefined => {
  if (value === undefined || value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const compact = value.replace(/\s/g, "");
    if (compact === "true" || compact === `\${{true}}`) return true;
    if (compact === "false" || compact === `\${{false}}`) return false;
  }
  return undefined;
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function rootDirectory(cwd: string): string {
  return findWorkspace(cwd) ?? resolve(cwd);
}

function regularFile(root: string, path: string): boolean {
  const full = join(root, path);
  try {
    const rel = relative(realpathSync(root), realpathSync(full));
    return (
      rel !== ".." &&
      !rel.startsWith(`..${sep}`) &&
      !isAbsolute(rel) &&
      lstatSync(full).isFile()
    );
  } catch {
    return false;
  }
}

export function read(root: string, path: string): Buffer {
  if (!regularFile(root, path))
    throw new Error(`${path}: missing regular file inside the working tree`);
  if (lstatSync(join(root, path)).size > 1024 * 1024)
    throw new Error(`${path}: exceeds the 1 MiB static inspection limit`);
  return readFileSync(join(root, path));
}

export function workingFiles(root: string): string[] {
  let paths: string[];
  try {
    paths = git(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .split("\0")
      .filter(Boolean);
  } catch {
    paths = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(join(root, directory), {
        withFileTypes: true,
      })) {
        if (
          [".git", ".gauge", "node_modules", ".next", ".venv", "venv"].includes(
            entry.name,
          )
        )
          continue;
        const path = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) paths.push(path);
        if (paths.length > 50_000)
          throw new Error(
            "Working tree exceeds 50,000 files; initialize Git and ignore generated files before verifying",
          );
      }
    };
    walk("");
  }
  return [...new Set(paths)].filter((path) => regularFile(root, path)).sort();
}

export const skippedInputEntry = (name: string) =>
  [
    ".git",
    ".gauge",
    "node_modules",
    ".aws",
    ".ssh",
    ".npmrc",
    ".pypirc",
  ].includes(name) ||
  name === ".env" ||
  name.startsWith(".env.");

function diskFiles(root: string, base: string): string[] {
  const paths: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      if (skippedInputEntry(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) paths.push(path);
      if (paths.length > 20_000) throw new Error("Input exceeds 20,000 files");
    }
  };
  walk(base === "." ? "" : base);
  return paths.sort();
}

function workflowChecks(
  root: string,
  input: Exclude<Input, { type: "website" }>,
): VerificationCheck[] {
  if (input.source.type !== "github-actions") return [];
  const source = input.source;
  const checks: VerificationCheck[] = [];
  let workflow: RecordValue;
  try {
    const document = parseDocument(
      read(root, source.workflow).toString("utf8"),
      { uniqueKeys: true },
    );
    if (document.errors.length)
      throw new Error(document.errors.map(message).join("; "));
    workflow = record(document.toJS());
    if (!Object.keys(record(workflow.jobs)).length)
      throw new Error("Expected a workflow jobs mapping");
    checks.push(
      check(
        "workflow",
        "yes",
        `${source.workflow} exists with a parseable YAML jobs mapping`,
      ),
    );
  } catch (error) {
    return [check("workflow", "no", message(error))];
  }
  const jobs = Object.entries(record(workflow.jobs))
    .map(([name, value]) => ({ name, job: record(value) }))
    .filter(({ job }) => condition(job.if) !== false);
  const steps = jobs.flatMap(({ name, job }) =>
    Array.isArray(job.steps)
      ? job.steps
          .map((value) => ({
            job: name,
            jobCondition: condition(job.if),
            step: record(value),
          }))
          .filter(({ step }) => condition(step.if) !== false)
      : [],
  );
  const opaque =
    jobs.some(({ job }) => typeof job.uses === "string") ||
    steps.some(
      ({ step }) =>
        typeof step.uses === "string" &&
        !/^actions\/(checkout|upload-artifact|setup-[^@]+)@/.test(step.uses),
    );
  const uploads = steps.filter(
    ({ step }) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  const candidates = uploads.filter(({ step }) => {
    const name = record(step.with).name ?? "artifact";
    return (
      !source.artifact ||
      dynamic(name) ||
      minimatch(String(name), source.artifact, { nonegate: true })
    );
  });
  const recognizedUpload =
    candidates.length === 1 &&
    !dynamic(record(candidates[0].step.with).name ?? "artifact");
  checks.push(
    check(
      "artifact-upload",
      recognizedUpload ? "yes" : "unknown",
      recognizedUpload
        ? `One direct upload step declares the matching artifact ${String(record(candidates[0].step.with).name ?? "artifact")}`
        : candidates.length
          ? `Found ${candidates.length} potentially matching upload step(s); resolve dynamic artifact names or overlapping uploads to establish a unique selection`
          : `No direct upload step matches ${source.artifact ?? "the configured artifact"}; ${opaque ? "inspect the referenced reusable workflows or custom actions" : "inspect build scripts or declare a matching actions/upload-artifact step"}`,
    ),
  );

  for (const [index, { job, jobCondition, step }] of candidates.entries()) {
    const options = record(step.with);
    const version = /^actions\/upload-artifact@v(\d+)(?:\.\d+){0,2}$/.exec(
      String(step.uses),
    );
    const major = version ? Number(version[1]) : undefined;
    let state: VerificationState =
      source.artifact && dynamic(options.name ?? "artifact")
        ? "unknown"
        : major === 7
          ? options.archive === true || options.archive === "true"
            ? "yes"
            : options.archive === undefined ||
                options.archive === false ||
                options.archive === "false"
              ? "no"
              : "unknown"
          : major !== undefined && major >= 4 && major <= 6
            ? "yes"
            : "unknown";
    const conditional =
      jobCondition === undefined || condition(step.if) === undefined;
    if (state === "no" && conditional) state = "unknown";
    const detail =
      source.artifact && dynamic(options.name ?? "artifact")
        ? "Resolve the artifact name expression to determine whether this upload is selected"
        : major === 7
          ? options.archive === true || options.archive === "true"
            ? "archive: true declares a ZIP artifact"
            : options.archive === undefined ||
                options.archive === false ||
                options.archive === "false"
              ? `archive: true is required for Gauge's ZIP download${conditional ? "; resolve the upload condition to determine whether this incompatible upload is selected" : ""}`
              : "Resolve the archive expression; Gauge requires archive: true"
          : major !== undefined && major >= 4 && major <= 6
            ? "This action version produces ZIP artifacts"
            : "Resolve the pinned action version; ZIP format is recognized for upload-artifact v4–v7 (v7 requires archive: true)";
    checks.push(
      check(
        `artifact-format.${index}`,
        state,
        `${job}: ${String(step.uses)}; ${detail}`,
      ),
    );
  }

  const checkouts = steps.filter(
    ({ step }) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@"),
  );
  const events =
    typeof workflow.on === "string"
      ? [workflow.on]
      : Array.isArray(workflow.on)
        ? workflow.on
        : Object.keys(record(workflow.on));
  const pr = events.includes("pull_request");
  const recognizedCheckout = (step: RecordValue) => {
    const options = record(step.with);
    if (options.repository !== undefined) return false;
    if (
      !events.length ||
      (options.ref !== undefined && typeof options.ref !== "string")
    )
      return false;
    const ref =
      typeof options.ref === "string" ? options.ref.replace(/\s/g, "") : "";
    return (
      (events.every((event) =>
        ["pull_request", "push", "workflow_dispatch"].includes(event),
      ) &&
        (!ref || ref === `\${{github.sha}}`)) ||
      ref === `\${{github.event.pull_request.head.sha||github.sha}}` ||
      (pr &&
        events.every((event) => event === "pull_request") &&
        ref === `\${{github.event.pull_request.head.sha}}`)
    );
  };
  const checkoutState =
    checkouts.length > 0 &&
    checkouts.every(({ step }) => recognizedCheckout(step))
      ? "yes"
      : "unknown";
  checks.push(
    check(
      "candidate-checkout",
      checkoutState,
      checkoutState === "yes"
        ? "Workflow checkout recognized, including the default PR merge checkout"
        : "Could not inspect checkout settings; check that your workflow builds the intended code",
    ),
  );
  const filtered = Object.values(record(workflow.on)).some((value) =>
    ["paths", "paths-ignore", "branches", "branches-ignore", "types"].some(
      (key) => record(value)[key] !== undefined,
    ),
  );
  const eligible = events.filter((event) =>
    ["pull_request", "push", "workflow_dispatch"].includes(String(event)),
  );
  const knownEvents =
    events.length > 0 && events.every((event) => !dynamic(event));
  checks.push(
    check(
      "workflow-trigger",
      eligible.length ? "yes" : knownEvents ? "no" : "unknown",
      eligible.length
        ? `Eligible trigger(s) declared: ${eligible.join(", ")}${filtered ? "; event filters are present" : ""}`
        : knownEvents
          ? `Declared event(s) ${events.join(", ")} are not eligible artifact sources; declare push, pull_request, or workflow_dispatch`
          : "Could not read workflow events; declare push, pull_request, or workflow_dispatch",
    ),
  );
  return checks;
}

function inputChecks(
  root: string,
  files: string[],
  input: Input,
  local: boolean,
): VerificationCheck[] {
  const checks = [
    check(
      "configuration",
      "yes",
      `Supported ${input.type} input from ${input.source.type === "git" ? "project files" : input.source.type}`,
    ),
  ];
  if (input.type === "website") return checks;
  if (input.type === "binary") {
    const excluded = Object.entries(input.commands).filter(
      ([, target]) =>
        !input.paths.some((pattern) =>
          minimatch(target, pattern, {
            dot: true,
            nocase: false,
            nonegate: true,
          }),
        ),
    );
    checks.push(
      check(
        "command-selection",
        excluded.length ? "no" : "yes",
        excluded.length
          ? `Declared command targets are excluded by paths: ${excluded.map(([name, target]) => `${name}: ${target}`).join(", ")}`
          : "Declared command targets match selected paths",
      ),
    );
  }
  if (input.source.type === "github-actions" && !local)
    checks.push(...workflowChecks(root, input));
  else {
    try {
      const patterns =
        input.type === "files" || input.type === "binary"
          ? input.paths
          : input.type === "skill" && !isSkillArchive(input.path)
            ? [input.path === "." ? "**" : `${input.path}/**`]
            : [input.path];
      const selected =
        local && input.type === "npm-package"
          ? globSync(input.path, { cwd: root })
          : matchInputPaths(
              local
                ? diskFiles(
                    root,
                    input.type === "skill" && !isSkillArchive(input.path)
                      ? input.path
                      : "",
                  )
                : files,
              patterns,
            );
      if (input.type === "binary") {
        for (const [command, target] of Object.entries(input.commands)) {
          if (!selected.includes(target))
            throw new Error(
              `Binary command ${command} target is missing or excluded by paths: ${target}`,
            );
        }
      }
      if (
        input.type === "npm-package" &&
        (selected.length !== 1 || !selected[0].endsWith(".tgz"))
      )
        throw new Error("npm-package must select exactly one .tgz file");
      if (
        input.type === "skill" &&
        !isSkillArchive(input.path) &&
        !selected.includes(
          input.path === "." ? "SKILL.md" : `${input.path}/SKILL.md`,
        )
      )
        throw new Error("Skill directory must contain SKILL.md at its root");
      checks.push(
        check(
          "local-paths",
          "yes",
          `${selected.length} ${local ? "local" : "working-tree"} file(s) selected`,
        ),
      );
    } catch (error) {
      checks.push(
        check(
          "local-paths",
          "no",
          message(error).replace(
            "committed files",
            local ? "local files" : "working-tree files",
          ),
        ),
      );
    }
  }
  return checks;
}

export function verifyEvals(
  cwd = process.cwd(),
  { local = false }: { local?: boolean } = {},
): EvalVerification {
  const root = rootDirectory(cwd);
  const result: EvalVerification = {
    version: 1,
    mode: "local-static",
    root,
    status: "passed",
    summary: { yes: 0, no: 0, unknown: 0 },
    facts: { configFilePresent: null, caseCount: null },
    info: [],
    notChecked: [
      "github-app-activation",
      "account-settings",
      "mcp-server-access",
      "mcp-server-reachability",
      "live-input-delivery",
      "artifact-contents",
      "sandbox-installation",
      "workflow-execution",
    ],
    global: [],
    inputs: [],
  };
  const finish = () => {
    for (const item of [
      ...result.global,
      ...result.inputs.flatMap((input) => input.checks),
    ])
      result.summary[item.state]++;
    result.status =
      result.summary.no > 0
        ? "failed"
        : result.summary.unknown > 0
          ? "incomplete"
          : "passed";
    return result;
  };
  let raw: unknown = {};
  let files: string[];
  try {
    files = workingFiles(root);
  } catch (error) {
    result.global.push(check("working-tree", "no", message(error)));
    return finish();
  }
  try {
    result.facts.configFilePresent =
      files.includes("gauge.json") || regularFile(root, "gauge.json");
    if (result.facts.configFilePresent)
      raw = JSON.parse(read(root, "gauge.json").toString("utf8"));
    else
      result.info.push({
        id: "config-file-absent",
        detail:
          "Optional gauge.json is absent; using default case discovery and no inputs",
      });
  } catch (error) {
    result.global.push(check("configuration", "no", message(error)));
    return finish();
  }
  const config = runDefinitionFileConfigSchema.safeParse(raw);
  result.global.push(
    check(
      "configuration",
      config.success ? "yes" : "no",
      config.success
        ? "Configuration matches the supported gauge.json schema"
        : oneLine(config.error.message),
    ),
  );
  const rawInputs = record(record(raw).inputs);
  for (const [name, value] of Object.entries(rawInputs).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const parsed = runDefinitionInputSchema.safeParse(value);
    result.inputs.push({
      name,
      checks: parsed.success
        ? inputChecks(root, files, parsed.data, local)
        : [check("configuration", "no", oneLine(parsed.error.message))],
    });
  }
  if (config.success) {
    try {
      const paths = matchInputPaths(files, config.data.cases, {
        allowEmptySelection: true,
      });
      if (paths.length > 20 || paths.some((path) => !path.endsWith(".md")))
        throw new Error("Expected at most 20 Markdown cases");
      result.facts.caseCount = paths.length;
      if (paths.length)
        result.global.push(
          check(
            "case-discovery",
            "yes",
            `${paths.length} working-tree case(s) selected`,
          ),
        );
      else
        result.info.push({
          id: "no-cases",
          detail:
            "No eval cases found; input-only setup is valid, but no evaluations will run",
        });
      for (const path of paths) {
        try {
          const item = parseRunDefinitionCase(path, read(root, path));
          if (local)
            assertLocalCapabilities(item.config, `${path}: config.`);
          const missing = (item.config.inputs ?? []).filter(
            (name) => !Object.hasOwn(config.data.inputs, name),
          );
          if (missing.length)
            throw new Error(`${path}: Unknown input(s): ${missing.join(", ")}`);
          const commandOwners = new Map<string, string>();
          for (const name of new Set(
            item.config.inputs ?? Object.keys(config.data.inputs),
          )) {
            const input = config.data.inputs[name];
            if (input.type !== "binary") continue;
            for (const command of Object.keys(input.commands)) {
              const owner = commandOwners.get(command);
              if (owner)
                throw new Error(
                  `${path}: Inputs ${owner} and ${name} both expose command ${command}; choose distinct commands or separate cases`,
                );
              commandOwners.set(command, name);
            }
          }
          result.global.push(
            check(
              `case.${path}`,
              "yes",
              "Case syntax, input references, and declared command names are valid",
            ),
          );
        } catch (error) {
          result.global.push(check(`case.${path}`, "no", message(error)));
        }
      }
    } catch (error) {
      result.global.push(
        check(
          "case-discovery",
          "no",
          message(error).replace("committed files", "working-tree files"),
        ),
      );
    }
  } else
    result.info.push({
      id: "case-validation-skipped",
      detail: "Fix gauge.json before validating cases and input references",
    });
  return finish();
}

export function printEvalVerification(result: EvalVerification): void {
  console.log(`Local static verification: ${result.root}`);
  const print = (checks: VerificationCheck[]) => {
    for (const item of checks)
      console.log(`  [${item.state}] ${item.id}: ${item.detail}`);
  };
  console.log("Global");
  print(result.global);
  for (const input of result.inputs) {
    console.log(`Input: ${input.name}`);
    print(input.checks);
  }
  for (const item of result.info)
    console.log(`[info] ${item.id}: ${item.detail}`);
  console.log(
    `Static verification ${result.status}: ${result.summary.yes} yes, ${result.summary.no} no, ${result.summary.unknown} unknown.`,
  );
  console.log(
    "Scope: repository setup only. Live delivery, account settings, and sandbox execution were not tested; no sessions were launched.",
  );
}
