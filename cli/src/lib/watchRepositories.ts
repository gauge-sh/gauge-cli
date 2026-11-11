import { existsSync } from "node:fs";
import { join } from "node:path";
import { openLocalStore } from "./localStore";

export function readWatchRepositories(gaugeDir: string, section: string, requestedPage = 1) {
  const pageSize = 25;
  const empty = section === "sources"
    ? { repositories: [], total: 0, page: 1, pageSize }
    : section === "canonical"
      ? { repositories: [], total: 0 }
      : { languages: [], total: 0, recorded: 0 };
  if (!existsSync(join(gaugeDir, "gauge.sqlite"))) return empty;
  const store = openLocalStore(gaugeDir);
  try {
    const total = Number(store.db.prepare("SELECT COUNT(*) AS n FROM source_repos").get()!.n);
    if (section === "canonical") {
      const repositories = store.db.prepare(`
        SELECT c.url, c.name, c.description, COUNT(s.source_url) AS count
        FROM canonical_repos c LEFT JOIN canonical_repo_sources s ON s.canonical_url = c.url
        GROUP BY c.url ORDER BY count DESC, c.name COLLATE NOCASE, c.url
      `).all().map(row => ({ ...row, share: total ? Number(row.count) / total * 100 : 0 }));
      return { repositories, total };
    }
    if (section === "sources") {
      const page = Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(total / pageSize)));
      const repositories = store.db.prepare(`
        SELECT url, commit_count AS commits, language_bytes AS languageBytes
        FROM source_repos ORDER BY url COLLATE NOCASE LIMIT ? OFFSET ?
      `).all(pageSize, (page - 1) * pageSize);
      return { repositories, total, page, pageSize };
    }
    const bytes = section === "language-bytes";
    const column = bytes ? "language_bytes" : "languages";
    const recorded = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM source_repos WHERE ${column} IS NOT NULL`).get()!.n);
    const languages = store.db.prepare(bytes ? `
      SELECT j.key AS name, SUM(j.value) AS value
      FROM source_repos r, json_each(r.language_bytes) j
      WHERE j.type IN ('integer', 'real') AND j.value > 0
      GROUP BY j.key ORDER BY value DESC, name
    ` : `
      SELECT j.value AS name, COUNT(DISTINCT r.url) AS value
      FROM source_repos r, json_each(r.languages) j WHERE j.type = 'text'
      GROUP BY j.value ORDER BY value DESC, name
    `).all();
    return { languages, total, recorded };
  } finally {
    store.close();
  }
}
