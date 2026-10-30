import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { Lifecycle } from "@withgauge/api-schemas/lifecycle";
import { lifecyclePatchFromOpts } from "./lifecycle";
import { assertLocalCapabilities } from "./localCapabilities";

function files(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gauge-lifecycle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    write(name: string, content: string | Buffer) {
      const path = join(directory, name);
      writeFileSync(path, content);
      return path;
    },
  };
}

const existing: Lifecycle = {
  version: 1,
  setup: { source: "console.log('old setup')", timeoutSeconds: 35 },
  teardown: { source: "console.log('cleanup')", timeoutSeconds: 75 },
  params: { feature: "checkout", nested: { enabled: false } },
};

describe("lifecycle file uploads", () => {
  it("rejects persisted hook configurations in the local backend", () => {
    assert.throws(
      () => assertLocalCapabilities({ lifecycle: existing }),
      /lifecycle requires hosted/,
    );
    assert.doesNotThrow(() => assertLocalCapabilities({ lifecycle: null }));
  });
  it("uploads exact UTF-8 source and JSON parameters with bounded defaults", (t) => {
    const f = files(t);
    const source =
      'import { params } from "@withgauge/session";\nconsole.log("界", params);\n';
    const result = lifecyclePatchFromOpts({
      setupFile: f.write("setup.ts", source),
      lifecycleParams: '{"feature":"checkout"}',
    });
    assert.deepEqual(result, {
      lifecycle: {
        version: 1,
        setup: { source, timeoutSeconds: 120 },
        params: { feature: "checkout" },
      },
    });
  });

  it("preserves the unedited phase, parameters and timeout when replacing source", (t) => {
    const path = files(t).write("new.ts", "console.log('new')");
    assert.deepEqual(lifecyclePatchFromOpts({ setupFile: path }, existing), {
      lifecycle: {
        ...existing,
        setup: { source: "console.log('new')", timeoutSeconds: 35 },
      },
    });
    assert.deepEqual(
      lifecyclePatchFromOpts({ teardownTimeout: "600" }, existing),
      {
        lifecycle: {
          ...existing,
          teardown: { ...existing.teardown, timeoutSeconds: 600 },
        },
      },
    );
    assert.equal(existing.setup?.source, "console.log('old setup')");
  });

  it("distinguishes omitted edits, one-phase clearing, and clearing the last phase", () => {
    assert.deepEqual(lifecyclePatchFromOpts({}, existing), {});
    assert.deepEqual(lifecyclePatchFromOpts({ clearSetup: true }, existing), {
      lifecycle: {
        version: 1,
        teardown: existing.teardown,
        params: existing.params,
      },
    });
    assert.deepEqual(
      lifecyclePatchFromOpts(
        { clearSetup: true, clearTeardown: true },
        existing,
      ),
      { lifecycle: null },
    );
    assert.deepEqual(
      lifecyclePatchFromOpts({ clearLifecycle: true }, existing),
      { lifecycle: null },
    );
    assert.deepEqual(
      lifecyclePatchFromOpts({ lifecycleParams: "{}" }, existing),
      { lifecycle: { ...existing, params: {} } },
    );
  });

  it("rejects unreadable, non-file, empty, invalid UTF-8, NUL and oversized inputs", (t) => {
    const f = files(t);
    for (const [path, pattern] of [
      [join(f.directory, "missing.ts"), /could not read --setup-file/],
      [f.directory, /regular file/],
      ["-", /stdin is not supported/],
      [f.write("empty.ts", " \n"), /nonempty/],
      [f.write("invalid.ts", Buffer.from([0xc3, 0x28])), /valid UTF-8/],
      [f.write("nul.ts", "console.log('x')\0"), /NUL/],
      [f.write("large.ts", "x".repeat(128 * 1024 + 1)), /128 KiB/],
      [f.write("unicode-large.ts", "界".repeat(50000)), /128 KiB/],
    ] as const)
      assert.throws(() => lifecyclePatchFromOpts({ setupFile: path }), pattern);
  });

  it("rejects conflicting flags, missing phases, invalid timeouts and parameter payloads", () => {
    assert.throws(
      () => lifecyclePatchFromOpts({ clearLifecycle: true, clearSetup: true }),
      /conflicts/,
    );
    assert.throws(
      () => lifecyclePatchFromOpts({ clearSetup: true, setupTimeout: "1" }),
      /conflicts/,
    );
    assert.throws(
      () => lifecyclePatchFromOpts({ setupTimeout: "1" }),
      /requires --setup-file/,
    );
    assert.throws(
      () => lifecyclePatchFromOpts({ lifecycleParams: "{}" }),
      /requires a setup or teardown/,
    );
    for (const value of ["0", "601", "1.5", "invalid", ""]) {
      assert.throws(
        () => lifecyclePatchFromOpts({ setupTimeout: value }, existing),
        /integer from 1 to 600/,
      );
    }
    for (const value of [
      "not-json",
      "null",
      "[]",
      '{"":"value"}',
      JSON.stringify({ text: "界".repeat(30000) }),
    ]) {
      assert.throws(() =>
        lifecyclePatchFromOpts({ lifecycleParams: value }, existing),
      );
    }
  });

  it("refuses an unknown saved lifecycle version rather than overwriting it", () => {
    assert.throws(
      () =>
        lifecyclePatchFromOpts({ clearSetup: true }, {
          ...existing,
          version: 2,
        } as unknown as Lifecycle),
      /unsupported/,
    );
  });
});
