import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalStore } from "./localStore";
import { readWatchRepositories } from "./watchRepositories";

test("repository summaries count shared sources once and preserve JSON for paginated rows", async t => {
  const root = await mkdtemp(join(tmpdir(), "watch-repos-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(readWatchRepositories(root, "language-counts"), { languages: [], total: 0, recorded: 0 });
  const store = openLocalStore(root);
  try {
    store.db.exec(`
      INSERT INTO canonical_repos VALUES ('https://example.com/a', 'A', 'First');
      INSERT INTO canonical_repos VALUES ('https://example.com/b', 'B', 'Second');
      INSERT INTO canonical_repos VALUES ('https://example.com/c', 'C', 'Empty');
      INSERT INTO source_repos (url, languages, commit_count, language_bytes)
      VALUES ('https://example.com/source', '["TypeScript","Python","Python"]', 12, '{ "TypeScript": 100, "Python": 50 }');
      INSERT INTO canonical_repo_sources VALUES ('https://example.com/a', 'https://example.com/source');
      INSERT INTO canonical_repo_sources VALUES ('https://example.com/b', 'https://example.com/source');
    `);
    const insert = store.db.prepare("INSERT INTO source_repos (url) VALUES (?)");
    for (let i = 0; i < 25; i++) insert.run(`https://example.com/z${String(i).padStart(2, "0")}`);
  } finally { store.close(); }
  const canonical = readWatchRepositories(root, "canonical") as any;
  assert.equal(canonical.total, 26);
  assert.deepEqual(canonical.repositories.map((row: any) => row.count), [1, 1, 0]);
  assert.equal(canonical.repositories[0].share, 100 / 26);
  const counts = readWatchRepositories(root, "language-counts") as any;
  assert.deepEqual(counts.languages.map((row: any) => ({ ...row })), [{ name: "Python", value: 1 }, { name: "TypeScript", value: 1 }]);
  assert.equal(counts.recorded, 1);
  const bytes = readWatchRepositories(root, "language-bytes") as any;
  assert.deepEqual(bytes.languages.map((row: any) => ({ ...row })), [{ name: "TypeScript", value: 100 }, { name: "Python", value: 50 }]);
  const first = readWatchRepositories(root, "sources") as any;
  assert.equal(first.repositories.length, 25);
  assert.equal(first.repositories[0].languageBytes, '{ "TypeScript": 100, "Python": 50 }');
  const last = readWatchRepositories(root, "sources", 100) as any;
  assert.equal(last.page, 2);
  assert.equal(last.repositories.length, 1);
});
