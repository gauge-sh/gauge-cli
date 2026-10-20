import { z } from "zod";
import { parseCliRuleArguments } from "./cli-rule-arguments";

export const CLI_RULE_LIMITS = {
  bundleBytes: 2 * 1024 * 1024,
  jsonTokens: 40_000,
  rules: 50,
  operations: 50,
  arguments: 256,
  argumentBytes: 4095,
  literalBytes: 8192,
  bufferBytes: 2 * 1024 * 1024,
  bufferWaitMs: 5000,
  maxBufferWaitMs: 120_000,
  expansionBytes: 64 * 1024 * 1024,
  excerptBytes: 4096,
  attemptExcerptBytes: 256 * 1024,
  journalBytes: 4 * 1024 * 1024,
  supervisorTasks: 4096,
} as const;

const encoder = new TextEncoder();
export const cliUtf8Bytes = (value: string) => encoder.encode(value).length;

const text = (max: number, nonempty = false) =>
  z.string().superRefine((value, ctx) => {
    if (
      (nonempty && !value.length) ||
      cliUtf8Bytes(value) > max ||
      /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        value,
      )
    )
      ctx.addIssue({
        code: "custom",
        message: `Use valid non-NUL UTF-8 text of at most ${max} bytes${nonempty ? ", not empty" : ""}`,
      });
  });
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
const flag = z
  .string()
  .regex(/^(?:-[A-Za-z0-9]|--[A-Za-z0-9][A-Za-z0-9-]{0,125})$/);
const envKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,126}$/);
const arg = text(CLI_RULE_LIMITS.argumentBytes);
const literal = text(CLI_RULE_LIMITS.literalBytes);
const stream = z.enum(["stdout", "stderr", "combined"]);
const exit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }).strict(),
  z
    .object({
      kind: z.literal("code"),
      value: z.number().int().min(0).max(255),
    })
    .strict(),
]);
const buffer = {
  maxBufferBytes: z
    .number()
    .int()
    .min(1)
    .max(CLI_RULE_LIMITS.bufferBytes)
    .default(CLI_RULE_LIMITS.bufferBytes),
  maxWaitMs: z
    .number()
    .int()
    .min(1)
    .max(CLI_RULE_LIMITS.maxBufferWaitMs)
    .default(CLI_RULE_LIMITS.bufferWaitMs),
};
const source = (value: z.ZodType<string>) =>
  z.discriminatedUnion("source", [
    z.object({ source: z.literal("literal"), value }).strict(),
    z.object({ source: z.literal("localFact"), key: envKey }).strict(),
  ]);

export function cliBoundedPattern(pattern: string): boolean {
  let at = pattern.startsWith("^") ? 1 : 0;
  const end =
    pattern.endsWith("$") && pattern.length > at
      ? pattern.length - 1
      : pattern.length;
  let stars = 0;
  let literals = 0;
  while (at < end) {
    const char = pattern[at];
    if (char === "\\") {
      if (++at >= end || !"\\.^$*+?[]{}()|".includes(pattern[at])) return false;
      literals++;
    } else if (char === "." && pattern[at + 1] === "*") {
      if (++stars > 1) return false;
      at++;
    } else if (".^$*+?[]{}()|\n\r".includes(char)) return false;
    else literals++;
    at++;
  }
  return literals > 0;
}

export const cliRuleTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("npmBin"),
      packageName: z
        .string()
        .max(214)
        .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
      program: z
        .string()
        .max(128)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("path"),
      path: text(1024, true).refine(
        (value) => !value.includes("\\") && !value.split("/").includes(".."),
        "Use a sandbox path without traversal",
      ),
    })
    .strict(),
]);

export const cliRuleSelectorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("exact"),
      argv: z.array(arg).max(CLI_RULE_LIMITS.arguments - 1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("command"),
      positionals: z
        .object({
          mode: z.enum(["exact", "prefix"]),
          tokens: z.array(arg).max(CLI_RULE_LIMITS.arguments - 1),
        })
        .strict(),
      optionsPresent: z.array(flag).max(100).default([]),
      optionsAbsent: z.array(flag).max(100).default([]),
      optionValues: z.record(flag, arg).default({}),
    })
    .strict(),
]);

export const cliRuleOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      kind: z.literal("replaceOutput"),
      stream,
      exit,
      replacement: literal,
      ...buffer,
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("streamOutput"),
      stream,
      edit: z.object({ find: text(8192, true), replace: literal }).strict(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("completeOutput"),
      stream,
      exit,
      replace: literal,
      ...buffer,
      matcher: z.discriminatedUnion("kind", [
        z
          .object({ kind: z.literal("literal"), text: text(8192, true) })
          .strict(),
        z
          .object({
            kind: z.literal("re2"),
            pattern: text(2048, true).refine(
              cliBoundedPattern,
              "Use literals, optional anchors, and at most one greedy .*",
            ),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("ensureOption"),
      option: flag,
      value: source(arg).optional(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("replaceOption"),
      option: flag,
      value: source(arg),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("setEnv"),
      key: envKey,
      value: source(arg),
      whenAbsent: z.boolean(),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("structuredStdin"),
      format: z.enum(["text", "json", "jsonl"]),
      payload: source(literal),
      timing: z.literal("onLaunch"),
      callerInput: z.literal("replace"),
      eof: z.literal("close"),
    })
    .strict(),
]);
export type CliRuleOperation = z.infer<typeof cliRuleOperationSchema>;

export function cliStructuredInputValid(
  format: "text" | "json" | "jsonl",
  payload: string,
): boolean {
  if (format === "text") return true;
  const records =
    format === "json" ? [payload] : payload.replace(/\r?\n$/, "").split("\n");
  try {
    return records.every((record) => {
      if (!record.trim()) return false;
      JSON.parse(record);
      return true;
    });
  } catch {
    return false;
  }
}

export const cliRuleSchema = z
  .object({
    id,
    selector: cliRuleSelectorSchema,
    optionArity: z
      .record(flag, z.union([z.literal(0), z.literal(1)]))
      .default({}),
    operations: z
      .array(cliRuleOperationSchema)
      .min(1)
      .max(CLI_RULE_LIMITS.operations),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    if (Object.keys(rule.optionArity).length > 100)
      fail(["optionArity"], "At most 100 option arities per rule");
    const arity = (key: string, expected?: number) =>
      Object.hasOwn(rule.optionArity, key) &&
      (expected === undefined || rule.optionArity[key] === expected);
    if (rule.selector.kind === "command") {
      const selector = rule.selector;
      for (const [field, flags] of [
        ["optionsPresent", selector.optionsPresent],
        ["optionsAbsent", selector.optionsAbsent],
        ["optionValues", Object.keys(selector.optionValues)],
      ] as const) {
        if (new Set(flags).size !== flags.length)
          fail(["selector", field], "Duplicate option predicate");
        for (const key of flags)
          if (!arity(key, field === "optionValues" ? 1 : undefined))
            fail(["selector", field], `Declare ${key}'s option arity`);
      }
      if (
        selector.optionsAbsent.some(
          (key) =>
            selector.optionsPresent.includes(key) ||
            Object.hasOwn(selector.optionValues, key),
        )
      )
        fail(["selector"], "An absent option cannot also be required");
    }
    if (
      rule.selector.kind === "exact" &&
      rule.operations.some(
        (op) => op.kind === "ensureOption" || op.kind === "replaceOption",
      )
    ) {
      const parsed = parseCliRuleArguments(
        rule.selector.argv,
        rule.optionArity,
      );
      if (parsed.kind === "ambiguous")
        fail(
          ["optionArity"],
          `Exact rules with argument edits must parse their argv (${parsed.reason}); declare each option's arity and supply its required value`,
        );
    }
    const ids = new Set<string>();
    const outputs = new Map<
      string,
      { kind: string; bytes?: number; wait?: number }
    >();
    let stdin = false;
    for (const [index, op] of rule.operations.entries()) {
      const path = ["operations", index];
      if (ids.has(op.id))
        fail([...path, "id"], "Duplicate operation ID within rule");
      ids.add(op.id);
      if (op.kind === "ensureOption" || op.kind === "replaceOption") {
        if (!arity(op.option, op.value === undefined ? 0 : 1))
          fail(
            path,
            "Argument operation value must agree with declared option arity",
          );
      } else if (op.kind === "structuredStdin") {
        if (stdin) fail(path, "Only one structured stdin operation per rule");
        stdin = true;
        if (
          op.payload.source === "literal" &&
          !cliStructuredInputValid(op.format, op.payload.value)
        )
          fail(path, "Payload does not match its declared JSON/JSONL format");
      } else if ("stream" in op) {
        const previous = outputs.get(op.stream);
        if (
          previous &&
          (previous.kind !== op.kind || op.kind === "replaceOutput")
        )
          fail(
            path,
            "Use one whole replacement or a chain of one output kind per stream",
          );
        if (
          previous &&
          op.kind === "completeOutput" &&
          (previous.bytes !== op.maxBufferBytes ||
            previous.wait !== op.maxWaitMs)
        )
          fail(
            path,
            "Completed operations on one stream must share buffer bounds",
          );
        outputs.set(op.stream, {
          kind: op.kind,
          ...("maxBufferBytes" in op
            ? { bytes: op.maxBufferBytes, wait: op.maxWaitMs }
            : {}),
        });
      }
    }
    if (outputs.has("combined") && outputs.size > 1)
      fail(
        ["operations"],
        "Combined output cannot be mixed with separate-stream output",
      );
  });
export type CliRule = z.infer<typeof cliRuleSchema>;

const body = {
  schemaVersion: z.literal(3),
  target: cliRuleTargetSchema,
  rules: z.array(cliRuleSchema).min(1).max(CLI_RULE_LIMITS.rules),
  shippingIntent: z.enum([
    "default",
    "message",
    "interaction",
    "invocation-guidance",
    "template",
  ]),
};
function jsonTokenCount(value: unknown): number {
  if (Array.isArray(value))
    return 1 + value.reduce((sum, item) => sum + jsonTokenCount(item), 0);
  if (value && typeof value === "object")
    return (
      1 +
      Object.values(value).reduce<number>(
        (sum, item) => sum + 1 + jsonTokenCount(item),
        0,
      )
    );
  return 1;
}

function validateBundle(value: { rules: CliRule[] }, ctx: z.RefinementCtx) {
  if (new Set(value.rules.map((rule) => rule.id)).size !== value.rules.length)
    ctx.addIssue({
      code: "custom",
      path: ["rules"],
      message: "Duplicate rule ID",
    });
  if (
    value.rules.reduce((count, rule) => count + rule.operations.length, 0) >
    CLI_RULE_LIMITS.operations
  )
    ctx.addIssue({
      code: "custom",
      path: ["rules"],
      message: "At most 50 operations across the bundle",
    });
  if (cliUtf8Bytes(JSON.stringify(value)) > CLI_RULE_LIMITS.bundleBytes)
    ctx.addIssue({ code: "custom", message: "CLI bundle exceeds 2 MiB" });
  if (jsonTokenCount(value) > CLI_RULE_LIMITS.jsonTokens)
    ctx.addIssue({
      code: "custom",
      message: "CLI bundle exceeds the native JSON token bound",
    });
}
export const cliRuleAuthorInputSchema = z
  .object(body)
  .strict()
  .superRefine(validateBundle);
export type CliRuleAuthorInput = z.input<typeof cliRuleAuthorInputSchema>;

const normalizedLimits = z
  .object({
    expansionBytes: z.literal(CLI_RULE_LIMITS.expansionBytes),
    excerptBytes: z.literal(CLI_RULE_LIMITS.excerptBytes),
    attemptExcerptBytes: z.literal(CLI_RULE_LIMITS.attemptExcerptBytes),
    journalBytes: z.literal(CLI_RULE_LIMITS.journalBytes),
    supervisorTasks: z.literal(CLI_RULE_LIMITS.supervisorTasks),
  })
  .strict()
  .default({
    expansionBytes: CLI_RULE_LIMITS.expansionBytes,
    excerptBytes: CLI_RULE_LIMITS.excerptBytes,
    attemptExcerptBytes: CLI_RULE_LIMITS.attemptExcerptBytes,
    journalBytes: CLI_RULE_LIMITS.journalBytes,
    supervisorTasks: CLI_RULE_LIMITS.supervisorTasks,
  });
export const cliRuleBundleSchema = z
  .object({
    ...body,
    limits: normalizedLimits,
    bundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine(validateBundle);
export type CliRuleBundle = z.infer<typeof cliRuleBundleSchema>;

export function isRetiredCliBundle(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return (
    "schemaVersion" in value &&
    (value.schemaVersion === 1 || value.schemaVersion === 2)
  );
}

export const CLI_RULE_GUIDANCE = [
  "Target one exposed owned CLI. Ordinary/reused session evidence is enough; no recorded invocation or command whitelist is needed.",
  "Use an exact logical argv array for a precise call; exclude the executable and interpreter prefix. ['--help'] differs from ['optimizations', '--help'].",
  "Argument edits require optionArity for every parsed option, including with exact selectors. For exact --help plus ensureOption --format=json, declare {'--help':0,'--format':1}; output-only exact rules need no arities.",
  "Use command positionals (exact or prefix), required/absent options, and last-occurrence option values for broader matching. Declare optionArity (0 or 1) on the rule, beside selector, never inside it. Unknown ambiguous options stop matching unchanged.",
  "For root help with globals: selector with exact empty positionals and optionsPresent ['--help'], plus rule optionArity {'--help':0,'--org':1}. This handles --org acme --help and --org=acme --help, but not optimizations --help or --version.",
  "Rules run in order against original arguments. First match wins, even if its edits do nothing, fail, or skip on exit. An exact --help rule before the broader help rule wins their overlap.",
  "Empty positional prefix with no option predicates explicitly matches every call of the selected CLI, without parsing options; usually put it last.",
  "Combine output, arguments, environment, and at most one structured stdin replacement. The real CLI still runs and decides whether inputs are valid. Stdin replacement declines caller input and can break an upstream pipe.",
  "Prompt recipes, generated-file edits, SDK/import interception, and package rebuilds are outside this intervention. Printed output changes do not change SDK error objects or application control flow.",
  "Review delivered before/after evidence and task results. Humans decide what to ship; delivery and score improvements are separate.",
] as const;
