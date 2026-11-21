import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineConfig } from "tsup";

type Manifest = {
  name: string;
  version: string;
  license?: string;
  dependencies?: Record<string, string>;
};

function packageDir(from: string, name: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`Cannot resolve ${name}`);
  }
}

// Third-party packages are bundled into dist (they are devDependencies, which
// tsup does not externalize), so the published package has no dependencies
// and installs without resolving any. The license notices of every bundled
// package, and of the packages those bundle in turn, ship alongside.
const bundledLicenses = {
  name: "bundled-licenses",
  setup(build: {
    onEnd(
      callback: (result: { metafile?: { inputs: object } }) => void,
    ): void;
  }) {
    build.onEnd((result) => {
      const queue: string[] = [];
      for (const input of Object.keys(result.metafile?.inputs ?? {})) {
        const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
        if (match) queue.push(match[1]);
      }
      const manifests = new Map<string, Manifest>();
      for (let dir = queue.shift(); dir; dir = queue.shift()) {
        if (manifests.has(dir)) continue;
        const manifest = JSON.parse(
          readFileSync(join(dir, "package.json"), "utf8"),
        ) as Manifest;
        manifests.set(dir, manifest);
        for (const name of Object.keys(manifest.dependencies ?? {}))
          queue.push(packageDir(dir, name));
      }
      const notices = [...manifests]
        .sort(([, a], [, b]) => a.name.localeCompare(b.name))
        .map(([dir, { name, version, license }]) => {
          const file = readdirSync(dir).find((entry) =>
            /^(?:licen[cs]e|copying)(?:\.(?:md|txt))?$/i.test(entry),
          );
          if (!file) throw new Error(`No license file for bundled ${name}`);
          return `${name}@${version} (${license ?? "see below"})\n\n${readFileSync(join(dir, file), "utf8").trim()}\n`;
        });
      writeFileSync(
        "dist/THIRD_PARTY_LICENSES.txt",
        `Third-party packages bundled into this distribution.\n\n${notices.join(`\n${"-".repeat(72)}\n\n`)}`,
      );
    });
  },
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    batchWorker: "src/batchWorker.ts",
    telemetryWorker: "src/telemetryWorker.ts",
    watchServer: "src/watchServer.ts",
    worker: "../packages/local/dist/worker.js",
  },
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  // Bundled CommonJS packages call require() for Node built-ins.
  banner: {
    js: 'import{createRequire as __gaugeCreateRequire}from"node:module";const require=__gaugeCreateRequire(import.meta.url);',
  },
  esbuildPlugins: [bundledLicenses],
  async onSuccess() {
    cpSync("src/watch", "dist/watch", { recursive: true });
  },
  esbuildOptions(options) {
    options.minifyWhitespace = true;
    options.legalComments = "eof";
    options.metafile = true;
  },
});
