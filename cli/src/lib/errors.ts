import type { Command } from "commander";
import { CommanderError } from "commander";
import { ZodError } from "zod";
import { CliError, type CliErrorCode, exitCodeFor } from "./client";
import { DOCS_URL } from "./docs";
import type { ModeSource } from "./gaugeState";
import { style } from "./output";

export type ErrorReport = {
  // A CLI error code, or the server's more specific code when it sent one.
  code: CliErrorCode | "internal" | (string & {});
  message: string;
  details?: Record<string, unknown>;
  hint?: string;
  docs: string;
  feedback?: string;
  exitCode: number;
};

type Issue = { path?: PropertyKey[]; message: string };

export type ErrorContext = { local?: ModeSource };

export function errorReport(
  error: unknown,
  command: string,
  context: ErrorContext = {},
): ErrorReport {
  const base =
    error instanceof CliError && error.needsAccount && context.local
      ? localModeError(command, context.local, error.hint)
      : describe(error);
  const quiet = base.message === "aborted" || command === "feedback";
  return {
    ...base,
    docs: base.docs ?? DOCS_URL,
    ...(quiet
      ? {}
      : {
          feedback: `gauge feedback -m "<what happened>" --kind friction${command ? ` --command "${command}"` : ""}`,
        }),
  };
}

function localModeError(
  command: string,
  source: ModeSource,
  hint?: string,
): Omit<ErrorReport, "docs" | "feedback"> & { docs?: string } {
  return {
    code: "usage",
    message: `\`gauge ${command}\` requires hosted Gauge; the selected backend is local (${source}).`,
    hint:
      hint ??
      "Pass --hosted for this command, or use `gauge init --hosted` to change this workspace's preference. Authentication is separate: `gauge auth login`.",
    exitCode: exitCodeFor("usage"),
  };
}

function describe(
  error: unknown,
): Omit<ErrorReport, "docs" | "feedback"> & { docs?: string } {
  if (error instanceof CliError)
    return {
      code: error.apiCode ?? error.code,
      message: readable(error.message),
      ...(error.details ? { details: error.details } : {}),
      hint: error.hint,
      docs: error.docs,
      exitCode: error.exitCode,
    };
  if (error instanceof CommanderError)
    return {
      code: "usage",
      message: error.message.replace(/^error: /, ""),
      hint: "Run the command with --help for its usage.",
      exitCode: exitCodeFor("usage"),
    };
  if (error instanceof ZodError)
    return {
      code: "usage",
      message: issueLines("Invalid input", error.issues),
      exitCode: exitCodeFor("usage"),
    };
  const node = error as NodeJS.ErrnoException | undefined;
  if (node?.code === "ENOENT" && node.path)
    return {
      code: "usage",
      message: `File not found: ${node.path}`,
      exitCode: exitCodeFor("usage"),
    };
  if (node?.code === "EACCES" && node.path)
    return {
      code: "usage",
      message: `Permission denied: ${node.path}`,
      exitCode: exitCodeFor("usage"),
    };
  return {
    code: "internal",
    message: `Unexpected error: ${error instanceof Error ? readable(error.message) : String(error)}`,
    hint: process.env.GAUGE_DEBUG
      ? undefined
      : "Set GAUGE_DEBUG=1 to print the stack trace.",
    exitCode: 1,
  };
}

export function readable(message: string): string {
  const start = message.search(/\[\s*\{/);
  if (start < 0) return message;
  try {
    const issues: unknown = JSON.parse(message.slice(start));
    if (
      !Array.isArray(issues) ||
      !issues.every((issue) => typeof issue?.message === "string")
    )
      return message;
    return issueLines(
      message.slice(0, start).replace(/[:\s]+$/, ""),
      issues as Issue[],
    );
  } catch {
    return message;
  }
}

function issueLines(prefix: string, issues: Issue[]): string {
  return [
    prefix,
    ...issues.map(
      (issue) =>
        `  ${issue.path?.length ? `${issue.path.map(String).join(".")}: ` : ""}${issue.message}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderError(report: ErrorReport, json: boolean): string {
  if (json) return `${JSON.stringify({ error: report }, null, 2)}\n`;
  const red = style("31", process.stderr);
  const dim = style("2", process.stderr);
  return `${[
    `${red("error:")} ${report.message}`,
    ...(report.hint ? [report.hint] : []),
    dim(`Docs: ${report.docs}`),
    ...(report.feedback ? [dim(`Hit friction? ${report.feedback}`)] : []),
  ].join("\n")}\n`;
}

export function commandPath(program: Command, argv: string[]): string {
  const names: string[] = [];
  let command = program;
  for (const token of argv) {
    if (token.startsWith("-")) continue;
    const next = command.commands.find(
      (sub) => sub.name() === token || sub.aliases().includes(token),
    );
    if (next) {
      names.push(token);
      command = next;
    } else if (command.commands.length === 0) break;
  }
  return names.join(" ");
}

export function wantsJson(argv: string[]): boolean {
  return argv.some(
    (token, i) =>
      token === "--output=json" ||
      token === "-ojson" ||
      ((token === "-o" || token === "--output") && argv[i + 1] === "json"),
  );
}
