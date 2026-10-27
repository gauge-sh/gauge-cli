import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MeResponse } from "@withgauge/api-schemas/me";
import { readConfig, updateConfig, writeConfig } from "../lib/config";
import { parseLoopbackCallback, readStdin, useOnlyOrg, type ChatMeResponse } from "./auth";

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
  let dir: string;
  let saved: string | undefined;
  const org = { id: "8c7f0e1a-1111-4222-8333-944455556666", slug: "acme", name: "Acme" };
  const identity = (orgs = [org]): ChatMeResponse => ({
    user: { id: "user", email: "user@test.com", name: "User" },
    orgs,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gauge-login-selection-"));
    saved = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces an old default with the only organization, even when its old slug differs", (t) => {
    t.mock.method(console, "log", () => {});
    for (const defaultOrg of ["acme", "acme-old-workspace", "previous-account"]) {
      writeConfig({ defaultOrg, backend: "hosted", apiUrl: "https://agents.test" });
      useOnlyOrg(identity(), true);
      assert.deepEqual(readConfig(), {
        orgId: org.id,
        backend: "hosted",
        apiUrl: "https://agents.test",
      });
    }
  });

  it("repairs an old default using the ID reported by an older Agents login", (t) => {
    t.mock.method(console, "log", () => {});
    updateConfig({ defaultOrg: "acme-old-workspace" });
    useOnlyOrg({
      orgs: [{ slug: "acme-old-workspace", canonicalGaugeOrganizationId: org.id }],
    } as MeResponse);
    assert.deepEqual(readConfig(), { orgId: org.id });
  });

  it("leaves the old selection intact when there is no single identified organization", () => {
    const before = { defaultOrg: "acme-old-workspace" };
    writeConfig(before);
    useOnlyOrg(identity([]), true);
    assert.deepEqual(readConfig(), before);
    useOnlyOrg(identity([org, { ...org, id: "1d2e3f40-5555-4666-8777-988899990000", slug: "beta" }]), true);
    assert.deepEqual(readConfig(), before);
    useOnlyOrg({ orgs: [{ slug: "acme-old-workspace" }] } as MeResponse);
    assert.deepEqual(readConfig(), before);
  });

  it("preserves an existing organization ID instead of switching organizations on login", () => {
    const before = { orgId: "1d2e3f40-5555-4666-8777-988899990000" };
    writeConfig(before);
    useOnlyOrg(identity(), true);
    assert.deepEqual(readConfig(), before);
  });

  it("selects the only organization on a first login", (t) => {
    t.mock.method(console, "log", () => {});
    useOnlyOrg(identity(), true);
    assert.deepEqual(readConfig(), { orgId: org.id });
  });
});
