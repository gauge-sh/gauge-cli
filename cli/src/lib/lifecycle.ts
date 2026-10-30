import { readFileSync, statSync } from "node:fs";
import {
  DEFAULT_LIFECYCLE_TIMEOUT_SECONDS,
  MAX_LIFECYCLE_SOURCE_LENGTH,
  MAX_LIFECYCLE_TIMEOUT_SECONDS,
  type Lifecycle,
  lifecycleSchema,
} from "@withgauge/api-schemas/lifecycle";
import type { Command } from "commander";
import { CliError } from "./client";

export type LifecycleOpts = {
  setupFile?: string;
  teardownFile?: string;
  setupTimeout?: string;
  teardownTimeout?: string;
  lifecycleParams?: string;
  clearSetup?: boolean;
  clearTeardown?: boolean;
  clearLifecycle?: boolean;
};

export function hasLifecycleFlags(opts: LifecycleOpts): boolean {
  return (
    opts.setupFile !== undefined ||
    opts.teardownFile !== undefined ||
    opts.setupTimeout !== undefined ||
    opts.teardownTimeout !== undefined ||
    opts.lifecycleParams !== undefined ||
    Boolean(opts.clearSetup || opts.clearTeardown || opts.clearLifecycle)
  );
}

export function addLifecycleOptions(command: Command): Command {
  return command
    .option(
      "--setup-file <path>",
      "upload a UTF-8 setup script for hosted sessions (JavaScript/TypeScript)",
    )
    .option(
      "--teardown-file <path>",
      "upload a UTF-8 teardown script for hosted sessions (JavaScript/TypeScript)",
    )
    .option(
      "--setup-timeout <seconds>",
      "setup deadline, 1–600 seconds (new scripts default to 120)",
    )
    .option(
      "--teardown-timeout <seconds>",
      "teardown deadline, 1–600 seconds (new scripts default to 120)",
    )
    .option(
      "--lifecycle-params <json>",
      "replace the scripts' JSON parameter object (maximum 64 KiB)",
    );
}

export function addLifecycleEditOptions(command: Command): Command {
  return addLifecycleOptions(command)
    .option("--clear-setup", "remove setup, preserving teardown and parameters")
    .option(
      "--clear-teardown",
      "remove teardown, preserving setup and parameters",
    )
    .option("--clear-lifecycle", "remove both scripts and their parameters");
}

function readScript(path: string, phase: "setup" | "teardown"): string {
  const flag = `--${phase}-file`;
  if (path === "-")
    throw new CliError(
      "usage",
      `${flag} requires a file path; stdin is not supported`,
    );
  let bytes: Buffer;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("expected a regular file");
    if (stat.size > MAX_LIFECYCLE_SOURCE_LENGTH)
      throw new Error("script must fit within 128 KiB");
    bytes = readFileSync(path);
  } catch (error) {
    throw new CliError(
      "usage",
      `could not read ${flag} ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (bytes.byteLength > MAX_LIFECYCLE_SOURCE_LENGTH)
    throw new CliError("usage", `${flag} script must fit within 128 KiB`);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new CliError("usage", `${flag} must contain valid UTF-8`);
  }
  if (!source.trim() || source.includes("\0"))
    throw new CliError(
      "usage",
      `${flag} must contain nonempty script text without NUL bytes`,
    );
  return source;
}

function timeout(raw: string | undefined, phase: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIFECYCLE_TIMEOUT_SECONDS
  )
    throw new CliError(
      "usage",
      `--${phase}-timeout must be an integer from 1 to ${MAX_LIFECYCLE_TIMEOUT_SECONDS}`,
    );
  return value;
}

/** The API replaces the lifecycle object. Edit callers fetch its current value
 * first so an individual phase update keeps the other phase and parameters. */
export function lifecyclePatchFromOpts(
  opts: LifecycleOpts,
  existing?: Lifecycle | null,
): { lifecycle?: Lifecycle | null } {
  if (!hasLifecycleFlags(opts)) return {};
  if (opts.clearLifecycle) {
    if (hasLifecycleFlags({ ...opts, clearLifecycle: false }))
      throw new CliError(
        "usage",
        "--clear-lifecycle conflicts with other lifecycle flags",
      );
    return { lifecycle: null };
  }
  const current =
    existing == null ? undefined : lifecycleSchema.safeParse(existing);
  if (current && !current.success)
    throw new CliError(
      "usage",
      "The saved lifecycle configuration is unsupported; update the CLI before editing it",
    );
  const value: Partial<Lifecycle> = current?.success
    ? { ...current.data }
    : { version: 1, params: {} };
  for (const phase of ["setup", "teardown"] as const) {
    const path = phase === "setup" ? opts.setupFile : opts.teardownFile;
    const rawTimeout =
      phase === "setup" ? opts.setupTimeout : opts.teardownTimeout;
    const clear = phase === "setup" ? opts.clearSetup : opts.clearTeardown;
    if (clear && (path !== undefined || rawTimeout !== undefined))
      throw new CliError(
        "usage",
        `--clear-${phase} conflicts with --${phase}-file/--${phase}-timeout`,
      );
    if (clear) {
      delete value[phase];
      continue;
    }
    const seconds = timeout(rawTimeout, phase);
    const source =
      path === undefined ? value[phase]?.source : readScript(path, phase);
    if (seconds !== undefined && source === undefined)
      throw new CliError(
        "usage",
        `--${phase}-timeout requires --${phase}-file or a saved ${phase} script`,
      );
    if (source !== undefined)
      value[phase] = {
        source,
        timeoutSeconds:
          seconds ??
          value[phase]?.timeoutSeconds ??
          DEFAULT_LIFECYCLE_TIMEOUT_SECONDS,
      };
  }
  if (opts.lifecycleParams !== undefined) {
    try {
      value.params = JSON.parse(opts.lifecycleParams);
    } catch {
      throw new CliError("usage", "--lifecycle-params must be a JSON object");
    }
  }
  if (!value.setup && !value.teardown) {
    if (opts.lifecycleParams !== undefined)
      throw new CliError(
        "usage",
        "--lifecycle-params requires a setup or teardown script",
      );
    return { lifecycle: null };
  }
  const parsed = lifecycleSchema.safeParse(value);
  if (!parsed.success)
    throw new CliError(
      "usage",
      parsed.error.issues[0]?.message ?? "Invalid lifecycle configuration",
    );
  return { lifecycle: parsed.data };
}
