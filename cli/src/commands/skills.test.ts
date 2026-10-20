import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { skills } from "@withgauge/api-schemas";
import { CliError } from "../lib/client";
import { buildSkillEditBody } from "./skills";

const TRACKED: skills.SkillSourceWire = {
  repoFullName: "acme/skills",
  ref: "main",
  subpath: "cli",
  autoIngest: false,
  lastSeenCommit: null,
  lastCheckedAt: null,
  lastError: null,
};

const currentSource = (source: skills.SkillSourceWire | null) => async () =>
  source;
const neverFetched = async (): Promise<skills.SkillSourceWire | null> => {
  throw new Error("fetchCurrentSource must not be called on this path");
};

describe("buildSkillEditBody — standalone --auto-ingest", () => {
  it("toggles the flag on a tracked skill by re-sending the current pointer", async () => {
    const body = await buildSkillEditBody(
      { autoIngest: "true" },
      currentSource(TRACKED),
    );
    assert.deepEqual(body, {
      source: {
        repoFullName: "acme/skills",
        ref: "main",
        subpath: "cli",
        autoIngest: true,
      },
    });
  });

  it("is a valid sole change alongside nothing else, and false works too", async () => {
    const body = await buildSkillEditBody(
      { autoIngest: "false" },
      currentSource({ ...TRACKED, subpath: "", autoIngest: true }),
    );
    assert.deepEqual(body, {
      source: {
        repoFullName: "acme/skills",
        ref: "main",
        subpath: undefined,
        autoIngest: false,
      },
    });
  });

  it("refuses on an untracked skill with a pointer at --source", async () => {
    await assert.rejects(
      buildSkillEditBody({ autoIngest: "true" }, currentSource(null)),
      /no tracked source/,
    );
  });

  it("is carried (not dropped) alongside --rename/--note", async () => {
    const body = await buildSkillEditBody(
      { rename: "acme-cli", note: "v2", autoIngest: "true" },
      currentSource(TRACKED),
    );
    assert.equal(body.name, "acme-cli");
    assert.equal(body.note, "v2");
    assert.deepEqual(
      (body.source as { autoIngest?: boolean }).autoIngest,
      true,
    );
  });

  it("rides the --source patch without a fetch when both are passed", async () => {
    const body = await buildSkillEditBody(
      { source: "acme/skills#dev/sub", autoIngest: "true" },
      neverFetched,
    );
    assert.deepEqual(body.source, {
      repoFullName: "acme/skills",
      ref: "dev",
      subpath: "sub",
      autoIngest: true,
    });
  });

  it("conflicts with --clear-source and rejects non-boolean values", async () => {
    await assert.rejects(
      buildSkillEditBody(
        { autoIngest: "true", clearSource: true },
        neverFetched,
      ),
      /--auto-ingest and --clear-source conflict/,
    );
    await assert.rejects(
      buildSkillEditBody({ autoIngest: "yes" }, neverFetched),
      /expects true or false/,
    );
  });
});

describe("buildSkillEditBody — existing semantics", () => {
  it("still refuses an empty edit", async () => {
    await assert.rejects(buildSkillEditBody({}, neverFetched), CliError);
  });

  it("still parses --source and the note/clear conflicts", async () => {
    const body = await buildSkillEditBody(
      { source: "acme/skills#main" },
      neverFetched,
    );
    assert.deepEqual(body.source, {
      repoFullName: "acme/skills",
      ref: "main",
      subpath: undefined,
      autoIngest: undefined,
    });
    await assert.rejects(
      buildSkillEditBody({ note: "x", clearNote: true }, neverFetched),
      /--note and --clear-note conflict/,
    );
  });
});
