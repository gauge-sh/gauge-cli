import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Mode } from "./gaugeState";
import { openLocalStore } from "./localStore";

export type ScaffoldResult = {
  root: string;
  backend: Mode;
  gaugeJson: "created" | "kept" | "not-requested";
  casesDir: "created" | "kept" | "not-requested";
  agentsMd: "created" | "added" | "updated" | "unchanged" | "not-requested";
};
const START = "<!-- gauge:start -->";
const END = "<!-- gauge:end -->";
export const AGENTS_BLOCK = `${START}
Gauge project inputs and optional shared cases are configured in gauge.json.
Saved evals and preference prompts, sessions, and analyses live in private .gauge/
state locally or the hosted organization. Shared cases use gauge-cases/.
Before using Gauge, run \`gauge instructions\`, then the relevant topic.
For product improvement or a first pilot, use \`gauge instructions hillclimb\`:
identify inputs, run representative sessions, analyze, improve, rerun, compare.
After local runs, follow \`gauge instructions session-analysis\` to publish
structured findings. Add \`-o json\` for machine-readable output.
${END}`;

export function scaffoldWorkspace(
  root: string,
  backend: Mode,
  cases = false,
): ScaffoldResult {
  mkdirSync(root, { recursive: true });
  const manifest = join(root, "gauge.json");
  const casesPath = join(root, "gauge-cases");
  const gaugeDir = join(root, ".gauge");
  const shared = cases || existsSync(casesPath);
  const result: ScaffoldResult = {
    root,
    backend,
    gaugeJson: existsSync(manifest)
      ? "kept"
      : shared
        ? "created"
        : "not-requested",
    casesDir: cases
      ? existsSync(casesPath)
        ? "kept"
        : "created"
      : "not-requested",
    agentsMd: shared
      ? writeAgentsBlock(join(root, "AGENTS.md"))
      : "not-requested",
  };
  if (result.gaugeJson === "created")
    writeFileSync(
      manifest,
      JSON.stringify({ version: 2, inputs: {} }, null, 2) + "\n",
    );
  mkdirSync(gaugeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(gaugeDir, ".gitignore"), "*\n");
  writeFileSync(
    join(gaugeDir, "config.json"),
    JSON.stringify({ version: 1, backend }, null, 2) + "\n",
    { mode: 0o600 },
  );
  const store = openLocalStore(gaugeDir);
  store.close();
  if (result.casesDir === "created") {
    mkdirSync(casesPath);
    writeFileSync(join(casesPath, ".gitkeep"), "");
  }
  return result;
}

function writeAgentsBlock(path: string): ScaffoldResult["agentsMd"] {
  if (!existsSync(path)) {
    writeFileSync(path, `${AGENTS_BLOCK}\n`);
    return "created";
  }
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(START);
  const end = start === -1 ? -1 : text.indexOf(END, start);
  if (end === -1) {
    const separator = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(path, `${text}${separator}${AGENTS_BLOCK}\n`);
    return "added";
  }
  const next =
    text.slice(0, start) + AGENTS_BLOCK + text.slice(end + END.length);
  if (next === text) return "unchanged";
  writeFileSync(path, next);
  return "updated";
}
