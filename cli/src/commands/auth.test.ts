import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, it } from "node:test";
import type { MeResponse } from "@withgauge/api-schemas/me";
import { readConfig, updateConfig } from "../lib/config";
import { parseLoopbackCallback, readStdin, useOnlyOrg } from "./auth";

describe("readStdin", () => {
  it("returns after one line when stdin is a TTY", async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;
    input.end("gauge_interactive\nignored\n");

    assert.equal(await readStdin(input), "gauge_interactive");
  });

  it("reads piped stdin through EOF", async () => {
    const input = Readable.from(["gauge_", "piped\n"]);

    assert.equal(await readStdin(input), "gauge_piped\n");
  });
});

describe("parseLoopbackCallback", () => {
  it("returns the code when state matches", () => {
    assert.equal(
      parseLoopbackCallback(
        "/callback?state=expected&code=gcli_code",
        "expected",
      ),
      "gcli_code",
    );
  });

  it("rejects a state mismatch or missing code", () => {
    assert.equal(
      parseLoopbackCallback("/callback?state=wrong&code=gcli_code", "expected"),
      null,
    );
    assert.equal(
      parseLoopbackCallback("/callback?state=expected", "expected"),
      null,
    );
  });
});

describe("useOnlyOrg", () => {
  it("sets the default org only for a single org and no existing default", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "gauge-config-"));
    const saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    t.after(() => {
      process.env.XDG_CONFIG_HOME = saved;
      rmSync(dir, { recursive: true, force: true });
    });
    t.mock.method(console, "log", () => {});
    const me = (slugs: string[]) =>
      ({ orgs: slugs.map((slug) => ({ slug })) }) as unknown as MeResponse;

    useOnlyOrg(me(["a", "b"]));
    assert.equal(readConfig().defaultOrg, undefined);
    useOnlyOrg(me(["acme"]));
    assert.equal(readConfig().defaultOrg, "acme");
    updateConfig({ defaultOrg: "other" });
    useOnlyOrg(me(["acme"]));
    assert.equal(readConfig().defaultOrg, "other");
  });
});
