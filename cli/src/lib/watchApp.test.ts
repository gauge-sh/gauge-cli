import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("the viewer refreshes an unavailable selection when it completes or becomes reachable", async () => {
  const source = await readFile(new URL("../watch/app.js", import.meta.url), "utf8");
  // Exercise the actual polling logic without starting its browser bootstrap.
  const context: Record<string, any> = {
    document: { getElementById: () => ({ textContent: "" }) },
    listStale: false,
    stale: false,
  };
  runInNewContext(source.slice(0, source.indexOf("// Rebuilding the list")), context);
  context.renderFilters = () => {};
  context.flush = () => {};
  let traces = 0;
  let diffs = 0;
  context.pollTrace = async () => { traces++; return false; };
  context.loadDiff = () => { diffs++; };
  for (const state of ["completed", "running"]) {
    context.state.selected = "r_one";
    context.state.tab = "diff";
    context.state.detail = { id: "r_one", state: "unavailable", lastKnownState: "running", live: false, turns: 1 };
    const next = { id: "r_one", state, lastKnownState: null, live: state === "running", turns: 1 };
    context.get = async (path: string) => path === "/api/sessions" ? JSON.stringify({ sessions: [next] }) : next;
    await context.tick();
    assert.equal(context.state.detail.state, state);
  }
  assert.equal(traces, 2);
  assert.equal(diffs, 1);
  assert.equal(context.matches({ state: "unavailable", live: false }, "failed"), false);
  assert.equal(context.matches({ state: "unavailable", live: false }, "unavailable"), true);
});
