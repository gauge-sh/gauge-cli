import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { cliRuleAuthorInputSchema } from "@withgauge/api-schemas/cli-rules";
import { CLI_RULES } from "../instructions/cliRules";
import { readCliRules } from "./cliRules";

const example = JSON.parse(
  CLI_RULES.split("\n\n").find((block) => block.startsWith("    {"))!,
);

it("ships a valid stub example with a literal newline in its output", () => {
  const rules = cliRuleAuthorInputSchema.parse(example);
  assert.deepEqual(rules.rules[0].operations[0], {
    id: "fake-token",
    kind: "stub",
    stdout: "test-token-not-a-real-credential\n",
    stderr: "",
    exitCode: 0,
  });
});

for (const [schemaVersion, operation] of [
  [4, { id: "redirect", kind: "exec", argv: ["/bin/echo", "test-token"] }],
  [
    3,
    {
      id: "env",
      kind: "setEnv",
      key: "EXAMPLE_MODE",
      value: { source: "literal", value: "test" },
      whenAbsent: true,
    },
  ],
] as const) {
  it(`reads schema v${schemaVersion} ${operation.kind} rules`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "gauge-cli-rules-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "rules.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...example,
        schemaVersion,
        rules: [{ ...example.rules[0], operations: [operation] }],
      }),
    );
    assert.deepEqual(readCliRules(path).rules[0].operations, [operation]);
  });
}

it("rejects oversized files, directories, and missing files clearly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "gauge-cli-rules-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "rules.json");
  writeFileSync(path, " ".repeat(2 * 1024 * 1024 + 1));
  assert.throws(() => readCliRules(path), /exceeds 2 MiB/);
  assert.throws(() => readCliRules(root), /regular JSON file/);
  assert.throws(
    () => readCliRules(join(root, "missing")),
    /Invalid --cli-rules file/,
  );
});
