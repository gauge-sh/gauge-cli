import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { list } from "tar";
import { isCaseSpec, parseCaseSpec } from "./caseSpec";
import { ApiClient } from "./client";
import {
  loadLocalRunDefinition,
  packLocalInput,
  parseInputOverrides,
  uploadLocalInputs,
} from "./localRunInputs";

const prompt =
  "---\ncriteria:\n  - name: Works\n    rubric: Task completed\nconfig:\n  agents:\n    - agent: CODEX_CLI\n      models: []\n---\nUse the skill.\n";
const resource = {
  name: "product",
  type: "input" as const,
  source: {
    type: "git" as const,
    repoUrl: "https://github.com/acme/product",
    commit: "a".repeat(40),
    paths: ["old/**"],
  },
  use: { type: "skill" as const, root: "old" },
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "gauge-local-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "gauge-cases"));
  await mkdir(join(root, "built"));
  await writeFile(
    join(root, "built", "SKILL.md"),
    "---\nname: product\ndescription: Do the task\n---\nInstructions",
  );
  await writeFile(join(root, "gauge-cases", "a.md"), prompt);
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({
      version: 2,
      org: "acme",
      inputs: { product: { type: "skill", path: "old" } },
    }),
  );
  return root;
}

test("submits current definitions and an uploaded skill without Git or a GitHub App", async (t) => {
  const root = await fixture(t);
  const loaded = await loadLocalRunDefinition([], ["product=./built"], root);
  t.after(loaded.cleanup);
  assert.equal(loaded.org, "acme");
  assert.deepEqual(loaded.definition.source, {
    repoUrl: null,
    commit: null,
    digest: loaded.definition.source.digest,
    verification: "LOCAL",
  });
  assert.equal(loaded.definition.resources[0].source.type, "upload");
  assert.deepEqual(loaded.definition.resources[0].use, {
    type: "skill",
    root: ".",
  });
  assert.equal(loaded.definition.cases[0].prompt, "Use the skill.");
  const first = loaded.uploads[0];
  assert.deepEqual(loaded.inputSnapshots, [{
    name: "product",
    source: "override",
    path: join(root, "built"),
    gaugeArchive: { sha256: first.sha256, bytes: first.bytes },
  }]);
  await writeFile(join(root, "built", "SKILL.md"), "changed");
  const changed = await loadLocalRunDefinition([], ["product=./built"], root);
  t.after(changed.cleanup);
  assert.notEqual(changed.uploads[0].sha256, first.sha256);
  assert.notDeepEqual(
    await readFile(first.path),
    await readFile(changed.uploads[0].path),
  );
});

test("uses edits and new cases in a Git checkout, and omits credentials in origin", async (t) => {
  const root = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "initial",
  );
  git("remote", "add", "origin", "https://token@github.com/acme/repo");
  await writeFile(
    join(root, "gauge-cases", "a.md"),
    prompt.replace("Use the skill.", "Current prompt."),
  );
  await writeFile(join(root, "gauge-cases", "new.md"), prompt);
  const loaded = await loadLocalRunDefinition([], ["product=./built"], root);
  t.after(loaded.cleanup);
  assert.equal(loaded.definition.source.repoUrl, null);
  assert.match(loaded.definition.source.commit ?? "", /^[a-f0-9]{40}$/);
  assert.equal(loaded.definition.cases.length, 2);
  assert.equal(loaded.definition.cases[0].prompt, "Current prompt.");
});

test("both backends snapshot dirty manifests, changed and untracked cases, and selected working-tree inputs", async (t) => {
  const root = await fixture(t);
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "guide.md"), "Committed guide");
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({
      version: 2,
      org: "committed-org",
      inputs: { docs: { type: "files", paths: ["docs/**"] } },
    }),
  );
  await writeFile(join(root, "gauge-cases", "deleted.md"), prompt);
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "initial",
  );
  git("remote", "add", "origin", "https://github.com/acme/example.git");
  const head = git("rev-parse", "HEAD");
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({
      version: 2,
      org: "working-org",
      inputs: { docs: { type: "files", paths: ["docs/**"] } },
      checks: { paths: ["unrelated/**"] },
    }),
  );
  await writeFile(
    join(root, "gauge-cases", "a.md"),
    prompt.replace("Use the skill.", "Edited task."),
  );
  await writeFile(
    join(root, "gauge-cases", "new.md"),
    prompt.replace("Use the skill.", "Untracked task."),
  );
  await rm(join(root, "gauge-cases", "deleted.md"));
  await writeFile(join(root, "docs", "guide.md"), "Edited guide");
  await writeFile(join(root, "docs", "new.md"), "Untracked guide");
  const snapshots = [];
  for (const local of [true, false]) {
    const loaded = await loadLocalRunDefinition([], [], root, { local });
    t.after(loaded.cleanup);
    snapshots.push(loaded);
    assert.equal(loaded.org, "working-org");
    assert.deepEqual(
      loaded.definition.cases.map((item) => [item.path, item.prompt]),
      [
        ["gauge-cases/a.md", "Edited task."],
        ["gauge-cases/new.md", "Untracked task."],
      ],
    );
    assert.equal(loaded.definition.source.commit, head);
    assert.equal(loaded.definition.source.verification, "LOCAL");
    assert.equal(loaded.definition.resources[0].source.type, "upload");
    assert.deepEqual(loaded.inputSnapshots, [{
      name: "docs",
      source: "working-tree",
      path: root,
      gaugeArchive: { sha256: loaded.uploads[0].sha256, bytes: loaded.uploads[0].bytes },
    }]);
    assert.deepEqual(await archiveContents(loaded.uploads[0].path), {
      "docs/guide.md": "Edited guide",
      "docs/new.md": "Untracked guide",
    });
  }
  assert.deepEqual(snapshots[0].definition, snapshots[1].definition);
  assert.equal(snapshots[0].uploads[0].sha256, snapshots[1].uploads[0].sha256);
  await writeFile(join(root, "docs", "guide.md"), "Another input revision");
  const revised = await loadLocalRunDefinition([], [], root, { local: false });
  t.after(revised.cleanup);
  assert.equal(
    revised.definition.source.commit,
    head,
    "HEAD is advisory provenance, not the identity of uploaded bytes",
  );
  assert.equal(
    revised.definition.source.digest,
    snapshots[0].definition.source.digest,
    "definition digest covers authored configuration and cases",
  );
  assert.notEqual(
    revised.uploads[0].sha256,
    snapshots[0].uploads[0].sha256,
    "input digest captures changed working-tree bytes independently",
  );
  await assert.rejects(
    loadLocalRunDefinition(["gauge-cases/deleted.md"], [], root),
    /No .*match/,
  );
});

async function archiveContents(file: string): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  await list({
    file,
    onReadEntry: (entry) => {
      const chunks: Buffer[] = [];
      entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      entry.on("end", () => {
        contents[entry.path.replace(/^\.\//, "")] =
          Buffer.concat(chunks).toString("utf8");
      });
    },
  });
  return contents;
}

test("case discovery uses the nearest manifest in a nested Git workspace", async (t) => {
  const root = await fixture(t);
  const nested = join(root, "packages", "app");
  await mkdir(join(nested, "gauge-cases"), { recursive: true });
  await mkdir(join(nested, "src"));
  await writeFile(
    join(nested, "gauge.json"),
    JSON.stringify({ version: 2, org: "nested-org", inputs: {} }),
  );
  await writeFile(join(nested, "gauge-cases", "nested.md"), prompt);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const loaded = await loadLocalRunDefinition([], [], join(nested, "src"));
  t.after(loaded.cleanup);
  assert.equal(loaded.org, "nested-org");
  assert.deepEqual(
    loaded.definition.cases.map((item) => item.path),
    ["gauge-cases/nested.md"],
  );
  assert.equal(loaded.definition.source.commit, null);
});

test("reads a workspace inside a Git-ignored directory", async (t) => {
  const root = await fixture(t);
  const nested = join(root, ".gauge", "docs-test");
  await mkdir(join(nested, "gauge-cases"), { recursive: true });
  await writeFile(
    join(nested, "gauge.json"),
    JSON.stringify({ version: 2, org: "ignored-org", inputs: {} }),
  );
  await writeFile(join(nested, "gauge-cases", "nested.md"), prompt);
  await writeFile(join(root, ".gitignore"), ".gauge/\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  const loaded = await loadLocalRunDefinition([], [], nested);
  t.after(loaded.cleanup);
  assert.equal(loaded.org, "ignored-org");
  assert.deepEqual(
    loaded.definition.cases.map((item) => item.path),
    ["gauge-cases/nested.md"],
  );
});

test("accepts standalone and symlinked workspace case globs in deterministic order", async (t) => {
  const root = await fixture(t);
  await rm(join(root, "gauge.json"));
  await writeFile(join(root, "gauge-cases", "b.md"), prompt);
  const loaded = await loadLocalRunDefinition(
    ["gauge-cases/b.md", "gauge-cases/a.md"],
    [],
    root,
  );
  t.after(loaded.cleanup);
  assert.deepEqual(
    loaded.definition.cases.map((item) => item.path),
    ["gauge-cases/a.md", "gauge-cases/b.md"],
  );
  assert.deepEqual(loaded.definition.resources, []);
  const aliasDir = await mkdtemp(join(tmpdir(), "gauge-workspace-link-"));
  t.after(() => rm(aliasDir, { recursive: true, force: true }));
  const alias = join(aliasDir, "workspace");
  await symlink(root, alias, "dir");
  const throughAlias = await loadLocalRunDefinition(
    ["gauge-cases/*.md"],
    [],
    alias,
  );
  t.after(throughAlias.cleanup);
  assert.deepEqual(throughAlias.definition, loaded.definition);
});

test("validates the current manifest and case contents without falling back to committed bytes", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({
      version: 2,
      defaults: { agents: [{ agent: "CODEX_CLI" }] },
    }),
  );
  await assert.rejects(loadLocalRunDefinition([], [], root), /defaults/);
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({ version: 2, inputs: {} }),
  );
  await writeFile(
    join(root, "gauge-cases", "a.md"),
    "---\ncriteria:\n  - name: Works\n    rubric: Works\n---\nTask\n",
  );
  await assert.rejects(loadLocalRunDefinition([], [], root), /config/);
  await rm(join(root, "gauge-cases"), { recursive: true });
  await assert.rejects(loadLocalRunDefinition([], [], root), /No case files/);
});

test("hosted runs preserve explicitly selected remote artifacts while local runs require an override", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "gauge.json"),
    JSON.stringify({
      version: 2,
      inputs: {
        product: {
          type: "skill",
          path: ".",
          source: {
            type: "github-actions",
            workflow: ".github/workflows/build.yml",
            artifact: "product",
          },
        },
      },
    }),
  );
  await assert.rejects(
    loadLocalRunDefinition([], [], root),
    /github-actions source requires a Git checkout/,
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "initial",
  );
  git("remote", "add", "origin", "https://github.com/acme/example.git");
  const hosted = await loadLocalRunDefinition([], [], root, { local: false });
  t.after(hosted.cleanup);
  assert.equal(hosted.uploads.length, 0);
  assert.equal(hosted.definition.resources[0].source.type, "github-actions");
  assert.equal(
    hosted.definition.resources[0].source.commit,
    hosted.definition.source.commit,
  );
  await assert.rejects(
    loadLocalRunDefinition([], [], root, { local: true }),
    /remote source.*--input product/,
  );
  const local = await loadLocalRunDefinition([], ["product=./built"], root, {
    local: true,
  });
  t.after(local.cleanup);
  assert.equal(local.definition.resources[0].source.type, "upload");
});

test("packages archives directly and ignores the old configured skill and npm paths", async (t) => {
  const root = await fixture(t);
  for (const [filename, use, expected] of [
    ["actual.zip", resource.use, { type: "skill", root: "actual.zip" }],
    [
      "actual.tgz",
      { type: "npm-package", package: "dist/*.tgz", install: "workspace" },
      { type: "npm-package", package: "actual.tgz", install: "workspace" },
    ],
  ] as const) {
    await writeFile(join(root, filename), "archive bytes validated by worker");
    const packed = await packLocalInput(
      { ...resource, use },
      join(root, filename),
      join(root, "output.tar.gz"),
    );
    assert.deepEqual(packed.use, expected);
    const paths: string[] = [];
    await list({
      file: packed.upload.path,
      onReadEntry: (entry) => {
        paths.push(entry.path.replace(/^\.\//, ""));
      },
    });
    assert.deepEqual(paths, [filename]);
  }
});

test("an unused website input does not block a local case selecting project files", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "gauge.json"), JSON.stringify({
    version: 2,
    inputs: {
      product: { type: "files", paths: ["built/**"] },
      website: {
        type: "website",
        url: "https://docs.example.com",
        source: { type: "github-deployment", environment: "preview" },
      },
    },
  }));
  await writeFile(join(root, "gauge-cases", "a.md"),
    prompt.replace("  agents:", "  inputs: [product]\n  agents:"));
  const loaded = await loadLocalRunDefinition([], [], root, { local: true });
  t.after(loaded.cleanup);
  assert.deepEqual(loaded.definition.resources.map((input) => input.name), ["product"]);
  assert.deepEqual(Object.keys(await archiveContents(loaded.uploads[0].path)), ["built/SKILL.md"]);
});

test("snapshot provenance identifies repacked bytes at the same npm input path", async (t) => {
  const root = await fixture(t);
  const path = join(root, "built", "product-1.0.0.tgz");
  await writeFile(join(root, "gauge.json"), JSON.stringify({
    version: 2,
    inputs: { product: { type: "npm-package", path: "built/*.tgz" } },
  }));
  const snapshots = [];
  for (const content of ["first packed version", "second packed version"]) {
    await writeFile(path, content);
    for (const local of [true, false]) {
      const loaded = await loadLocalRunDefinition([], [], root, { local });
      t.after(loaded.cleanup);
      assert.deepEqual(loaded.inputSnapshots, [{
        name: "product",
        source: "working-tree",
        path,
        gaugeArchive: { sha256: loaded.uploads[0].sha256, bytes: loaded.uploads[0].bytes },
      }]);
      assert.deepEqual(await archiveContents(loaded.uploads[0].path), {
        "product-1.0.0.tgz": content,
      });
      snapshots.push(loaded.inputSnapshots[0]);
    }
  }
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(snapshots[2], snapshots[3]);
  assert.notEqual(snapshots[0].gaugeArchive.sha256, snapshots[2].gaugeArchive.sha256);
});

test("selects files relative to the supplied directory without credentials, dependencies, or links", async (t) => {
  const root = await fixture(t);
  const dir = join(root, "built");
  await writeFile(join(dir, ".env"), "SECRET");
  await writeFile(join(dir, ".npmrc"), "TOKEN");
  await writeFile(
    join(dir, "@literal"),
    "ordinary file, not an archive reference",
  );
  await mkdir(join(dir, "node_modules"));
  await writeFile(join(dir, "node_modules", "dep"), "dependency");
  const packed = await packLocalInput(
    { ...resource, use: { type: "files", paths: ["**"] } },
    dir,
    join(root, "output.tar.gz"),
  );
  const paths: string[] = [];
  await list({
    file: packed.upload.path,
    onReadEntry: (entry) => {
      paths.push(entry.path.replace(/^\.\//, ""));
    },
  });
  assert.deepEqual(paths, ["@literal", "SKILL.md"]);
  await symlink(join(root, "gauge.json"), join(dir, "link"));
  const linked = await packLocalInput(
    { ...resource, use: { type: "files", paths: ["SKILL.md"] } },
    dir,
    join(root, "linked.tar.gz"),
  );
  const linkedPaths: string[] = [];
  await list({
    file: linked.upload.path,
    onReadEntry: (entry) => {
      linkedPaths.push(entry.path.replace(/^\.\//, ""));
    },
  });
  assert.deepEqual(linkedPaths, ["SKILL.md"]);
  await mkdir(join(dir, ".gauge", "docs"), { recursive: true });
  await writeFile(join(dir, ".gauge", "docs", "draft.md"), "draft");
  await assert.rejects(
    packLocalInput(
      { ...resource, use: { type: "files", paths: [".gauge/docs/*.md"] } },
      dir,
      join(root, "gauge.tar.gz"),
    ),
    /\.gauge\/docs\/\*\.md is inside \.gauge\/\. Inputs never include \.gauge\//,
  );
  await assert.rejects(
    packLocalInput(
      { ...resource, use: { type: "files", paths: ["missing/*.md"] } },
      dir,
      join(root, "missing.tar.gz"),
    ),
    /^CliError: Input product: No files match missing\/\*\.md$/,
  );
});

test("rejects duplicate and unknown overrides, escaped case paths, and missing local inputs", async (t) => {
  const root = await fixture(t);
  assert.throws(
    () => parseInputOverrides(["product=a", "product=b"]),
    /Duplicate/,
  );
  assert.throws(() => parseInputOverrides(["product"]), /name=path/);
  await assert.rejects(
    loadLocalRunDefinition([], ["unknown=./built"], root),
    /Unknown input/,
  );
  await assert.rejects(
    loadLocalRunDefinition(["../outside.md"], ["product=./built"], root),
    /inside the definition/,
  );
  await assert.rejects(
    loadLocalRunDefinition([], [], root),
    /Input path does not exist/,
  );
});

for (const statuses of [
  [200],
  [412],
  [409, 200],
  [409, 412],
  [409, 409, 409],
  [409, 500],
  [403],
]) {
  test(`upload handles HTTP ${statuses.join(" → ")}`, async (t) => {
    const root = await fixture(t);
    const packed = await packLocalInput(
      resource,
      join(root, "built"),
      join(root, "input.tar.gz"),
    );
    const expected = await readFile(packed.upload.path);
    const client = new ApiClient({ token: null });
    const url = "https://uploads.example.test/input";
    const headers = { "If-None-Match": "*" };
    const sign = t.mock.method(client, "post", async () => ({ url, headers }));
    const responses: Response[] = [];
    const streams = new Set<unknown>();
    const upload = t.mock.method(
      globalThis,
      "fetch",
      async (actualUrl: string, init: RequestInit) => {
        assert.equal(actualUrl, url);
        assert.equal(init.method, "PUT");
        assert.deepEqual(init.headers, headers);
        assert.equal(init.redirect, "error");
        assert.equal(streams.has(init.body), false);
        streams.add(init.body);
        const chunks: Buffer[] = [];
        for await (const chunk of init.body as unknown as AsyncIterable<Buffer>)
          chunks.push(chunk);
        assert.deepEqual(Buffer.concat(chunks), expected);
        const status = statuses[responses.length];
        assert.ok(status, "must not retry beyond the expected attempts");
        const response = new Response("response body", { status });
        responses.push(response);
        return response;
      },
    );
    const result = uploadLocalInputs(client, "acme", [packed.upload]);
    const final = statuses.at(-1);
    if (final === 200 || final === 412) await result;
    else
      await assert.rejects(
        result,
        new RegExp(`Input upload failed \\(${final}\\)`),
      );
    assert.equal(sign.mock.callCount(), 1);
    assert.equal(upload.mock.callCount(), statuses.length);
    assert.ok(responses.every((response) => response.bodyUsed));
  });
}

test("runs a case spec without Markdown; criteria are optional only for local runs", async (t) => {
  const root = await fixture(t);
  const spec = parseCaseSpec({
    version: 2,
    cases: [
      {
        key: "quick",
        prompt: "Do the task.",
        config: { agents: [{ agent: "CODEX_CLI" }] },
      },
    ],
  });
  const loaded = await loadLocalRunDefinition([], ["product=./built"], root, {
    local: true,
    spec,
  });
  t.after(loaded.cleanup);
  assert.deepEqual(
    loaded.definition.cases.map((item) => [item.path, item.prompt]),
    [["quick", "Do the task."]],
  );
  assert.equal(loaded.definition.resources[0].source.type, "upload");
  await assert.rejects(
    loadLocalRunDefinition([], ["product=./built"], root, { spec }),
    /Hosted cases need criteria or preference: quick/,
  );
});

test("rejects invalid case specs and tells battery specs apart", () => {
  assert.equal(isCaseSpec({ version: 2, cases: [] }), true);
  assert.equal(isCaseSpec({ version: 1, prompts: [] }), false);
  assert.throws(
    () =>
      parseCaseSpec({
        version: 2,
        cases: [
          { key: "a", prompt: "x", config: { agents: [{ agent: "PI" }] } },
          { key: "a", prompt: "y", config: { agents: [{ agent: "PI" }] } },
        ],
      }),
    /Case keys must be unique/,
  );
});
