"use strict";
var FILTERS = [["all", "All"], ["live", "Live"], ["completed", "Completed"], ["failed", "Failed"]];
var state = { sessions: [], filter: "all", query: "", selected: null, detail: null, tab: "trace",
  events: [], inputs: [], lastSeq: -1, diff: null, diffOpen: {}, traceToken: 0,
  mode: "sessions", evals: [], evalId: null, evalDetail: null, evalRevision: null, evalJson: "" };

function h(tag, attrs) {
  var el = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (k === "class") el.className = attrs[k];
    else if (k === "text") el.textContent = attrs[k];
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), attrs[k]);
    else el.setAttribute(k, attrs[k]);
  }
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c == null || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

function ago(iso) {
  if (!iso) return "";
  var s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return Math.floor(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function duration(ms) {
  if (ms == null) return "";
  var s = Math.round(ms / 1000);
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}
function turns(n) { return n + (n === 1 ? " turn" : " turns"); }
function clock(iso) { return iso ? new Date(iso).toLocaleTimeString() : ""; }
function stateClass(s) { return s.live ? "live" : s.state; }
function text(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}
function clip(v, n) { v = text(v); return v.length > n ? v.slice(0, n) + "\n… (" + (v.length - n) + " more characters)" : v; }

async function get(path, type) {
  var res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(res.status + " " + path);
  return type === "text" ? res.text() : res.json();
}

function renderFilters() {
  var box = document.getElementById("filters");
  var seg = box.querySelector(".seg");
  if (!seg) {
    seg = h("div", { class: "seg" });
    var input = h("input", { placeholder: "Filter by case, agent, model, or ID" });
    input.addEventListener("input", function () { state.query = input.value.toLowerCase(); renderList(); });
    box.appendChild(seg);
    box.appendChild(input);
  }
  seg.textContent = "";
  var live = state.sessions.filter(function (s) { return s.live; }).length;
  FILTERS.forEach(function (f) {
    var label = f[1] + (f[0] === "live" && live ? " " + live : "");
    seg.appendChild(h("button", { class: state.filter === f[0] ? "on" : "", onclick: function () { state.filter = f[0]; renderFilters(); renderList(); } }, label));
  });
}

var AGENTS = { CLAUDE_CODE: "Claude Code", CODEX_CLI: "Codex", OPENCODE: "OpenCode", PI: "Pi" };
function agentName(a) { return AGENTS[a] || a; }

function splitCase(path) {
  path = (path || "").replace(/^gauge-cases\//, "").replace(/\.md$/, "");
  var i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

function visible() {
  return state.sessions.filter(function (s) {
    if (state.filter === "live" && !s.live) return false;
    if (state.filter === "completed" && s.state !== "completed") return false;
    if (state.filter === "failed" && !(s.state === "failed" || s.state === "interrupted" || s.state === "canceled")) return false;
    if (!state.query) return true;
    return [s.case, s.agent, agentName(s.agent), s.model, s.id, s.batchId].join(" ").toLowerCase().indexOf(state.query) >= 0;
  });
}

function renderModes() {
  var box = document.getElementById("modes");
  box.textContent = "";
  var seg = h("div", { class: "seg" });
  [["evals", "Evals"], ["sessions", "Sessions"]].forEach(function (m) {
    seg.appendChild(h("button", { class: state.mode === m[0] ? "on" : "", onclick: function () {
      if (state.mode === m[0]) return;
      location.hash = m[0] === "evals" ? (state.evalId ? "#/eval/" + state.evalId : "#/evals") : (state.selected ? "#/session/" + state.selected : "#/");
    } }, m[1]));
  });
  box.appendChild(seg);
  document.getElementById("filters").style.display = state.mode === "sessions" ? "" : "none";
}

function pct(passed, total) { return total ? Math.round(100 * passed / total) + "%" : "–"; }

function renderEvalList() {
  var list = document.getElementById("list");
  var scroll = list.scrollTop;
  list.textContent = "";
  if (!state.evals.length) {
    list.appendChild(h("div", { class: "empty", style: "padding:24px" }, "No evals yet. Create one with gauge eval create."));
    return;
  }
  state.evals.forEach(function (e) {
    var graded = e.analyzed ? pct(e.passed, e.analyzed) + " pass (" + e.passed + "/" + e.analyzed + ")" : "not graded";
    list.appendChild(h("div", { class: "row" + (e.id === state.evalId ? " sel" : ""), title: e.name, onclick: function () { location.hash = "#/eval/" + e.id; } },
      h("span", { class: "dot " + (e.analyzed ? (e.passed === e.analyzed ? "completed" : e.passed ? "canceled" : "failed") : "") }),
      h("span", { class: "case" }, e.name),
      h("span", { class: "age" }, e.lastRunAt ? ago(e.lastRunAt) + " ago" : ""),
      h("span", { class: "meta" }, "r" + e.revision + " · " + e.criteria + (e.criteria === 1 ? " criterion" : " criteria")),
      h("span", { class: "meta" }, e.sessions + (e.sessions === 1 ? " session" : " sessions") + " · " + graded)));
  });
  list.scrollTop = scroll;
}

function renderList() {
  if (state.mode === "evals") return renderEvalList();
  var list = document.getElementById("list");
  var scroll = list.scrollTop;
  list.textContent = "";
  var rows = visible();
  if (!rows.length) {
    list.appendChild(h("div", { class: "empty", style: "padding:24px" }, state.sessions.length ? "No sessions match." : "No sessions yet. Start one with gauge run."));
    return;
  }
  var batch = null;
  rows.forEach(function (s) {
    if (s.batchId !== batch) {
      batch = s.batchId;
      list.appendChild(h("div", { class: "batch" }, "Batch " + batch.slice(0, 8)));
    }
    var name = s.case ? splitCase(s.case) : ["", s.id];
    var stats = [s.state === "completed" ? null : s.state, s.turns ? turns(s.turns) : null, s.live ? null : duration(s.durationMs)].filter(Boolean).join(" · ");
    var who = [agentName(s.agent), s.model].filter(Boolean).join(" · ");
    list.appendChild(h("div", { class: "row" + (s.id === state.selected ? " sel" : ""), title: s.case || s.id, onclick: function () { location.hash = "#/session/" + s.id; } },
      h("span", { class: "dot " + stateClass(s) }),
      h("span", { class: "case" }, name[1]),
      h("span", { class: "age", title: s.createdAt ? "Started " + new Date(s.createdAt).toLocaleString() : "" }, s.createdAt ? ago(s.createdAt) + " ago" : ""),
      h("span", { class: "meta" }, who || "\u00a0"),
      h("span", { class: "meta" }, stats || "\u00a0")));
  });
  list.scrollTop = scroll;
}

function usageTotals() {
  var t = { input: 0, output: 0, seen: false };
  state.events.forEach(function (e) {
    var p = e.payload;
    if (!p || p.type !== "usage") return;
    t.seen = true;
    t.input += (p.input_tokens || 0) + (p.cache_read_input_tokens || 0) + (p.cache_creation_input_tokens || 0);
    t.output += p.output_tokens || 0;
  });
  return t;
}

function compact(n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }

function renderHead(view) {
  var s = state.detail;
  var name = s.case ? splitCase(s.case) : ["", s.id];
  var u = usageTotals();
  var fields = [
    ["State", s.state, stateClass(s)],
    ["Agent", agentName(s.agent)], ["Model", s.model], ["Turns", String(s.turns)],
    ["Duration", s.durationMs != null ? duration(s.durationMs) : null],
    ["Tokens", u.seen ? compact(u.input) + " in / " + compact(u.output) + " out" : s.inputTokens != null ? compact(s.inputTokens) + " in / " + compact(s.outputTokens || 0) + " out" : null],
    ["Measurement", s.measurement ? s.measurement.kind + " r" + s.measurement.revision : null],
    ["Sample", s.sample != null ? String(s.sample) : null],
    ["Started", s.createdAt ? new Date(s.createdAt).toLocaleString() : null],
    ["Run", s.id],
  ];
  var grid = h("dl", { class: "meta-grid" });
  fields.forEach(function (f) {
    if (!f[1]) return;
    var value = f[0] === "Measurement" && s.measurement.kind === "eval" ? h("a", { href: "#/eval/" + s.measurement.id }, f[1]) : f[1];
    grid.appendChild(h("div", null, h("dt", null, f[0]), h("dd", { class: f[2] || "" }, value)));
  });
  view.appendChild(h("div", { class: "head" },
    h("h2", null, h("span", { class: "dot " + stateClass(s) }), h("span", null, h("span", { class: "dir" }, name[0]), name[1])),
    s.prompt ? h("div", { class: "prompt mono", title: s.prompt }, "› " + s.prompt) : null,
    grid,
    s.detail && !s.live && s.state !== "completed" ? h("div", { class: "detail" }, s.detail) : null));
  var tabs = h("div", { class: "tabs" });
  [["trace", "Trace"], ["task", "Task"], ["diff", "Diff"]].forEach(function (t) {
    tabs.appendChild(h("button", { class: state.tab === t[0] ? "on" : "", onclick: function () { location.hash = "#/session/" + state.selected + "/" + t[0]; } }, t[1]));
  });
  view.appendChild(tabs);
}

var WORKSPACE = /\/gauge\/session\/workspace\/?/g;
function short(v) { return String(v).replace(WORKSPACE, ""); }

function markdown(value) {
  var root = h("div", { class: "t-msg" });
  var lines = String(value || "").trim().split("\n");
  var para = [], list = null, fence = null;
  function flush() {
    if (para.length) root.appendChild(inline(h("p"), para.join("\n")));
    para = [];
    list = null;
  }
  lines.forEach(function (line) {
    if (fence) {
      if (line.trim().slice(0, 3) === "```") { root.appendChild(h("pre", null, fence.join("\n"))); fence = null; }
      else fence.push(line);
      return;
    }
    if (line.trim().slice(0, 3) === "```") { flush(); fence = []; return; }
    var bullet = /^\s*(?:[-*]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (para.length) flush();
      var tag = bullet[1] ? "ol" : "ul";
      if (!list || list.tagName.toLowerCase() !== tag) { list = h(tag); root.appendChild(list); }
      list.appendChild(inline(h("li"), bullet[2]));
      return;
    }
    var heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) { flush(); root.appendChild(inline(h("h4"), heading[1])); return; }
    if (!line.trim()) { flush(); return; }
    list = null;
    para.push(line);
  });
  if (fence) root.appendChild(h("pre", null, fence.join("\n")));
  flush();
  return root;
}

function toolSummary(call) {
  var input = call.input;
  if (input && typeof input === "object") {
    var v = input.command || input.cmd || input.file_path || input.path || input.url || input.query || input.pattern;
    if (Array.isArray(v)) v = v.join(" ");
    if (typeof v === "string") return short(v.split("\n")[0]);
  }
  return clip(input, 120).split("\n")[0];
}

function timeline() {
  var results = {};
  state.events.forEach(function (e) { if (e.payload && e.payload.type === "tool_result") results[e.payload.tool_id] = e; });
  var items = [];
  state.inputs.forEach(function (i, n) {
    if (n === 0 && state.detail && typeof i.text === "string" && i.text.trim() === (state.detail.prompt || "").trim()) return;
    items.push({ at: i.observedAt, order: -1, input: i }); });
  state.events.forEach(function (e) {
    var p = e.payload || {};
    if (p.type === "tool_result" && p.tool_id && state.events.some(function (x) { return x.payload && x.payload.type === "tool_call" && x.payload.tool_id === p.tool_id; })) return;
    items.push({ at: e.observedAt, order: e.seq, event: e, result: p.type === "tool_call" ? results[p.tool_id] : null });
  });
  items.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order; });
  return items;
}

function inline(el, value) {
  String(value || "").split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/).forEach(function (part) {
    if (/^\*\*[^*]+\*\*$/.test(part)) el.appendChild(h("b", null, part.slice(2, -2)));
    else if (/^`[^`]+`$/.test(part)) el.appendChild(h("code", null, part.slice(1, -1)));
    else if (part) el.appendChild(document.createTextNode(part));
  });
  return el;
}

function firstLine(v) {
  var lines = text(v).split("\n").filter(function (l) { return l.trim(); });
  if (!lines.length) return "(no output)";
  return short(lines[0]) + (lines.length > 1 ? "  … +" + (lines.length - 1) + " lines" : "");
}

function renderItem(item) {
  if (item.input) {
    var i = item.input;
    var user = h("div", { class: "t-user" }, "› " + (i.text != null ? i.text : text(i.answer)));
    return item.first ? user : h("div", null, h("div", { class: "t-turn" }, (i.text != null ? "Turn " : "Answer · turn ") + i.turn), user);
  }
  var e = item.event, p = e.payload || {};
  if (p.type === "agent_message") return markdown(p.text);
  if (p.type === "reasoning") {
    var think = inline(h("div", { class: "t-think clamp", title: clock(e.observedAt) }), String(p.text || "").trim());
    think.addEventListener("click", function () { think.classList.toggle("clamp"); });
    return think;
  }
  if (p.type === "usage") return null;
  if (p.type === "tool_call" || p.type === "tool_result") {
    var r = item.result ? item.result.payload : p.type === "tool_result" ? p : null;
    var err = r && r.is_error;
    var dot = r ? (err ? "failed" : "completed") : state.detail.live ? "live" : "";
    var box = h("div", { class: "t-tool" + (err ? " err" : "") },
      h("div", { class: "call", title: clock(e.observedAt), onclick: function () { box.classList.toggle("open"); } },
        h("span", { class: "dot " + dot }),
        h("span", { class: "name" }, p.name || p.tool_kind || "tool"),
        h("span", { class: "arg" }, toolSummary(p))),
      h("div", { class: "out" }, "⎿ " + (r ? firstLine(r.output) : state.detail.live ? "running…" : "(no result)")),
      h("div", { class: "full" },
        h("div", { class: "kv" }, "Input"), h("pre", null, clip(p.input, 20000)),
        r ? h("div", { class: "kv" }, "Output" + (r.outputBytes ? " · " + r.outputBytes.toLocaleString() + " bytes" : "")) : null,
        r ? h("pre", null, clip(r.output, 20000)) : null));
    return box;
  }
  if (p.type === "harness_action") return h("div", { class: "t-err" }, "✕ " + p.action + ": " + (p.message || ""));
  return h("pre", null, clip(p, 4000));
}

function renderTrace(body, open) {
  var items = timeline();
  var root = h("div", { class: "trace" });
  body.appendChild(root);
  body = root;
  var group = null;
  items.forEach(function (item, n) {
    item.first = n === 0;
    var el = renderItem(item);
    if (!el) return;
    if (item.event) {
      el.dataset.seq = item.event.seq;
      if (open[item.event.seq]) el.classList.add("open");
    }
    if (el.classList.contains("t-tool")) {
      if (!group) { group = h("div", { class: "t-tools" }); body.appendChild(group); }
      group.appendChild(el);
    } else {
      group = null;
      body.appendChild(el);
    }
  });
  if (!items.length) body.appendChild(h("div", { class: "pending" }, state.detail.live ? "Waiting for the agent's first event…" : "This session recorded no trace events."));
  else if (state.detail.live && !(body.lastChild && body.lastChild.querySelector(".dot.live"))) body.appendChild(h("div", { class: "pending" }, h("span", { class: "dot live" }), state.detail.state + "…"));
}

function renderTask(body) {
  var s = state.detail;
  body = body.appendChild(h("div", { class: "task" }));
  body.appendChild(h("div", { class: "kv" }, "Prompt"));
  body.appendChild(h("pre", null, s.prompt || "(none)"));
  if (Array.isArray(s.criteria) && s.criteria.length) {
    body.appendChild(h("div", { class: "kv" }, "Criteria"));
    var list = h("ol", { class: "criteria" });
    s.criteria.forEach(function (c, n) {
      var name = typeof c === "string" ? c : c.name || c.text || c.description || c.id || "";
      var rubric = typeof c === "string" ? null : c.rubric || (c.name && c.text) || null;
      list.appendChild(h("li", null, h("span", { class: "n" }, String(n + 1)), h("span", { class: "name" }, name), rubric ? h("span", { class: "rubric" }, rubric) : null));
    });
    body.appendChild(list);
  }
  if (s.preference) {
    body.appendChild(h("div", { class: "kv" }, "Preference"));
    body.appendChild(h("pre", null, text(s.preference)));
  }
}

var LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/;

function parseDiff(textValue) {
  var files = [], file = null, oldNo = 0, newNo = 0;
  textValue.split("\n").forEach(function (line) {
    if (line.slice(0, 11) === "diff --git ") {
      var m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      file = { path: m ? m[2] : line.slice(11), from: m ? m[1] : null, status: "", lines: [], add: 0, del: 0, binary: false };
      files.push(file);
      return;
    }
    if (!file) return;
    if (!file.lines.length) {
      if (line.slice(0, 13) === "new file mode") { file.status = "new"; return; }
      if (line.slice(0, 17) === "deleted file mode") { file.status = "deleted"; return; }
      if (line.slice(0, 12) === "rename from ") { file.from = line.slice(12); file.status = "renamed"; return; }
      if (line.slice(0, 10) === "rename to ") { file.path = line.slice(10); return; }
      if (line.slice(0, 12) === "Binary files") { file.binary = true; return; }
      if (line.slice(0, 4) === "--- " || line.slice(0, 4) === "+++ " || line.slice(0, 6) === "index " || /^(old|new) mode|^similarity index/.test(line)) return;
    }
    var hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) { oldNo = +hunk[1]; newNo = +hunk[2]; file.lines.push({ kind: "hunk", text: line }); return; }
    if (!file.lines.length) return;
    var c = line[0];
    if (c === "+") { file.add++; file.lines.push({ kind: "add", newNo: newNo++, text: line.slice(1) }); }
    else if (c === "-") { file.del++; file.lines.push({ kind: "del", oldNo: oldNo++, text: line.slice(1) }); }
    else if (c === "\\") file.lines.push({ kind: "meta", text: line.slice(2) });
    else if (c === " ") file.lines.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text: line.slice(1) });
  });
  return files;
}

function renderDiff(body) {
  if (state.diff == null) return body.appendChild(h("div", { class: "pending" }, "Loading…"));
  if (!state.diff) return body.appendChild(h("div", { class: "pending" }, state.detail.live ? "The diff is written when the session ends." : "No diff."));
  var files = parseDiff(state.diff);
  if (!files.length) return body.appendChild(h("pre", null, state.diff));
  var adds = 0, dels = 0;
  files.forEach(function (f) { adds += f.add; dels += f.del; });
  body.appendChild(h("div", { class: "d-summary" },
    h("b", null, files.length + (files.length === 1 ? " file changed" : " files changed")),
    h("span", { class: "d-add" }, "+" + adds), h("span", { class: "d-del" }, "−" + dels)));
  files.forEach(function (f) {
    var key = state.selected + ":" + f.path;
    if (!(key in state.diffOpen)) state.diffOpen[key] = !LOCKFILES.test(f.path) && f.add + f.del <= 600;
    var i = f.path.lastIndexOf("/");
    var box = h("div", { class: "d-file" + (state.diffOpen[key] ? "" : " closed") });
    box.appendChild(h("div", { class: "d-head", onclick: function () { state.diffOpen[key] = !state.diffOpen[key]; box.classList.toggle("closed"); } },
      h("span", { class: "chev" }, "▾"),
      h("span", { class: "path", title: f.path }, h("span", null, f.from && f.status === "renamed" ? f.from + " → " : f.path.slice(0, i + 1)), f.path.slice(i + 1)),
      f.status ? h("span", { class: "badge" }, f.status) : null,
      h("span", { class: "stats" }, f.add ? h("span", { class: "d-add" }, "+" + f.add) : null, f.del ? h("span", { class: "d-del" }, "−" + f.del) : null)));
    var inner = h("div", { class: "d-body" });
    if (f.binary) inner.appendChild(h("div", { class: "d-note" }, "Binary file not shown."));
    else if (!f.lines.length) inner.appendChild(h("div", { class: "d-note" }, "No content changes."));
    else {
      var table = h("table", { class: "d-table" });
      f.lines.forEach(function (l) {
        if (l.kind === "hunk") return table.appendChild(h("tr", { class: "hunk" }, h("td", { colspan: "4" }, l.text)));
        if (l.kind === "meta") return table.appendChild(h("tr", { class: "meta" }, h("td", { colspan: "4" }, l.text)));
        table.appendChild(h("tr", { class: l.kind },
          h("td", { class: "ln" }, l.oldNo != null ? String(l.oldNo) : ""),
          h("td", { class: "ln" }, l.newNo != null ? String(l.newNo) : ""),
          h("td", { class: "sign" }, l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "),
          h("td", null, l.text)));
      });
      inner.appendChild(table);
    }
    box.appendChild(inner);
    body.appendChild(box);
  });
}

function criterionName(c) { return typeof c === "string" ? c : c.name || c.id || ""; }
function criterionId(c, n) { return typeof c === "string" ? String(n) : c.id || String(n); }

function renderEvalView(view) {
  var d = state.evalDetail;
  if (!d) {
    view.appendChild(h("div", { class: "empty" }, state.evalId ? "Loading…" : state.evals.length ? "Select an eval." : "No evals yet. Create one with gauge eval create."));
    return;
  }
  var rev = d.revisions.find(function (r) { return r.revision === state.evalRevision; }) || d.revisions[0];
  var live = {};
  state.sessions.forEach(function (s) { live[s.id] = s; });
  var runs = d.runs.filter(function (r) { return (r.revision == null ? d.revision : r.revision) === rev.revision; }).map(function (r) {
    var s = live[r.id];
    return Object.assign({}, r, { state: s ? s.state : r.outcome, live: s ? s.live : false });
  });
  var graded = runs.filter(function (r) { return r.results; });
  var passed = graded.filter(function (r) {
    var o = Object.keys(r.results).map(function (k) { return r.results[k].outcome; });
    return o.indexOf("PASS") >= 0 && o.indexOf("FAIL") < 0;
  });
  var running = runs.filter(function (r) { return r.live; }).length;
  var fields = [
    ["Revision", "r" + rev.revision + (rev.revision === d.revision ? "" : " of " + d.revision)],
    ["Criteria", String(rev.criteria.length)],
    ["Sessions", String(runs.length) + (running ? " · " + running + " live" : "")],
    ["Graded", String(graded.length)],
    ["Pass rate", graded.length ? pct(passed.length, graded.length) + " (" + passed.length + "/" + graded.length + ")" : null],
    ["Last run", d.lastRunAt ? ago(d.lastRunAt) + " ago" : null],
    ["Tags", d.tags.length ? d.tags.join(", ") : null],
    ["Eval", d.id],
  ];
  var grid = h("dl", { class: "meta-grid" });
  fields.forEach(function (f) { if (f[1]) grid.appendChild(h("div", null, h("dt", null, f[0]), h("dd", null, f[1]))); });
  var head = h("div", { class: "head" },
    h("h2", null, d.name),
    h("div", { class: "prompt mono", title: rev.promptText }, "› " + rev.promptText),
    grid);
  if (d.revisions.length > 1) {
    var seg = h("div", { class: "seg revs" });
    d.revisions.forEach(function (r) {
      seg.appendChild(h("button", { class: r.revision === rev.revision ? "on" : "", onclick: function () { state.evalRevision = r.revision; renderView(); } }, "r" + r.revision));
    });
    head.appendChild(seg);
  }
  view.appendChild(head);
  var body = h("div", { class: "body" });
  view.appendChild(body);

  var groups = [], byKey = {};
  runs.forEach(function (r) {
    var key = agentName(r.agent) + " · " + r.model;
    if (!byKey[key]) { byKey[key] = { key: key, runs: [] }; groups.push(byKey[key]); }
    byKey[key].runs.push(r);
  });
  body.appendChild(h("div", { class: "kv" }, "Results"));
  if (!graded.length) body.appendChild(h("div", { class: "note" }, runs.length ? "No graded sessions for this revision yet." : "No sessions for this revision yet. Launch one with gauge run --eval " + d.id + "."));
  else {
    var table = h("table", { class: "matrix" });
    var hr = h("tr", null, h("th", null, ""));
    groups.forEach(function (g) {
      var n = g.runs.filter(function (r) { return r.results; }).length;
      hr.appendChild(h("th", null, h("div", null, g.key), h("div", { class: "sub" }, n + " graded")));
    });
    table.appendChild(h("thead", null, hr));
    var tbody = h("tbody");
    function cell(pass, total) {
      if (!total) return h("td", { class: "na" }, "–");
      var rate = pass / total;
      return h("td", { class: rate >= 0.8 ? "good" : rate >= 0.5 ? "mid" : "bad", title: pass + " of " + total + " passed" }, pct(pass, total), h("span", { class: "sub" }, " " + pass + "/" + total));
    }
    rev.criteria.forEach(function (c, n) {
      var id = criterionId(c, n);
      var tr = h("tr", null, h("th", { title: c.rubric || "" }, criterionName(c)));
      groups.forEach(function (g) {
        var pass = 0, total = 0;
        g.runs.forEach(function (r) {
          var x = r.results && r.results[id];
          if (!x || x.outcome === "UNASSESSABLE") return;
          total++;
          if (x.outcome === "PASS") pass++;
        });
        tr.appendChild(cell(pass, total));
      });
      tbody.appendChild(tr);
    });
    var all = h("tr", { class: "all" }, h("th", null, "All criteria"));
    groups.forEach(function (g) {
      var gg = g.runs.filter(function (r) { return r.results; });
      all.appendChild(cell(gg.filter(function (r) { return passed.indexOf(r) >= 0; }).length, gg.length));
    });
    tbody.appendChild(all);
    table.appendChild(tbody);
    body.appendChild(table);
  }

  if (runs.length) {
    body.appendChild(h("div", { class: "kv" }, "Sessions"));
    var list = h("div", { class: "eval-runs" });
    runs.forEach(function (r) {
      var chips = h("span", { class: "chips" });
      rev.criteria.forEach(function (c, n) {
        var x = r.results && r.results[criterionId(c, n)];
        var cls = !x ? "none" : x.outcome === "PASS" ? "pass" : x.outcome === "FAIL" ? "fail" : "na";
        chips.appendChild(h("span", { class: "chip " + cls, title: criterionName(c) + ": " + (x ? x.outcome + " — " + x.label : "not graded") }));
      });
      list.appendChild(h("a", { class: "eval-run", href: "#/session/" + r.id },
        h("span", { class: "dot " + (r.live ? "live" : r.state) }),
        h("span", null, agentName(r.agent) + " · " + r.model),
        chips,
        h("span", { class: "muted" }, [r.turns ? turns(r.turns) : null, duration(r.durationMs), ago(r.createdAt) + " ago"].filter(Boolean).join(" · "))));
    });
    body.appendChild(list);
  }

  body.appendChild(h("div", { class: "kv" }, "Criteria"));
  var ol = h("ol", { class: "criteria" });
  rev.criteria.forEach(function (c, n) {
    ol.appendChild(h("li", null, h("span", { class: "n" }, String(n + 1)), h("span", { class: "name" }, criterionName(c)), c.rubric ? h("span", { class: "rubric" }, c.rubric) : null));
  });
  body.appendChild(ol);
}

function renderView() {
  var view = document.getElementById("view");
  if (state.mode === "evals") {
    var prev = view.querySelector(".body");
    var top = prev ? prev.scrollTop : 0;
    view.textContent = "";
    renderEvalView(view);
    var next = view.querySelector(".body");
    if (next) next.scrollTop = top;
    return;
  }
  var old = view.querySelector(".body");
  var atBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
  var scroll = old ? old.scrollTop : 0;
  var open = {};
  if (old) old.querySelectorAll(".t-tool.open").forEach(function (el) { open[el.dataset.seq] = 1; });
  view.textContent = "";
  if (!state.detail) {
    view.appendChild(h("div", { class: "empty" }, state.selected ? "Loading…" : "Select a session. Running sessions update live."));
    return;
  }
  renderHead(view);
  var body = h("div", { class: "body" });
  view.appendChild(body);
  if (state.tab === "trace") renderTrace(body, open);
  else if (state.tab === "task") renderTask(body);
  else renderDiff(body);
  body.scrollTop = state.tab === "trace" && state.detail.live && atBottom ? body.scrollHeight : scroll;
}

async function loadDiff() {
  if (!state.selected) return;
  var id = state.selected;
  try { var d = await get("/api/sessions/" + id + "/diff", "text"); if (id === state.selected) { state.diff = d; renderView(); } }
  catch (e) { if (id === state.selected) { state.diff = ""; renderView(); } }
}

async function pollTrace() {
  var id = state.selected, token = state.traceToken;
  if (!id) return;
  var t = await get("/api/sessions/" + id + "/trace?after=" + state.lastSeq);
  if (id !== state.selected || token !== state.traceToken) return;
  var fresh = t.events.filter(function (e) { return e.seq > state.lastSeq; });
  if (fresh.length) {
    state.events = state.events.concat(fresh);
    state.lastSeq = fresh[fresh.length - 1].seq;
  }
  state.inputs = t.inputs;
}

async function select(id) {
  state.selected = id;
  state.detail = null; state.events = []; state.inputs = []; state.lastSeq = -1; state.diff = null; state.traceToken++;
  renderList(); renderView();
  if (!id) return;
  try {
    state.detail = await get("/api/sessions/" + id);
    await pollTrace();
    if (state.tab === "diff") loadDiff();
  } catch (e) {
    state.detail = null;
    document.getElementById("view").textContent = "";
    document.getElementById("view").appendChild(h("div", { class: "empty" }, "Session " + id + " was not found."));
    return;
  }
  renderView();
  var body = document.querySelector(".body");
  if (body && state.detail.live) body.scrollTop = body.scrollHeight;
}

async function loadEval() {
  var id = state.evalId;
  if (!id) return;
  try {
    var raw = await get("/api/evals/" + id, "text");
    if (id !== state.evalId || raw === state.evalJson) return;
    var first = !state.evalDetail;
    state.evalJson = raw;
    state.evalDetail = JSON.parse(raw);
    if (first) state.evalRevision = state.evalDetail.revision;
  } catch (e) {
    if (id !== state.evalId) return;
    state.evalDetail = null; state.evalJson = "";
    document.getElementById("view").textContent = "";
    document.getElementById("view").appendChild(h("div", { class: "empty" }, "Eval " + id + " was not found."));
    return;
  }
  renderView();
}

async function loadEvals() {
  state.evals = (await get("/api/evals")).evals;
  if (state.mode === "evals") renderList();
}

function route() {
  var e = /^#\/evals?(?:\/([A-Za-z0-9_-]+))?$/.exec(location.hash);
  state.mode = e ? "evals" : "sessions";
  renderModes();
  if (e) {
    var id = e[1] || null;
    if (id !== state.evalId) { state.evalId = id; state.evalDetail = null; state.evalJson = ""; }
    renderList(); renderView();
    loadEvals();
    loadEval();
    return;
  }
  var m = /^#\/session\/([A-Za-z0-9_-]+)(?:\/(trace|task|diff))?$/.exec(location.hash);
  if (m && m[2]) state.tab = m[2];
  if (m && m[1] === state.selected) { if (state.tab === "diff") loadDiff(); renderList(); renderView(); return; }
  select(m ? m[1] : null);
}

async function tick() {
  var conn = document.getElementById("conn");
  try {
    state.sessions = (await get("/api/sessions")).sessions;
    var live = state.sessions.filter(function (s) { return s.live; }).length;
    conn.textContent = state.sessions.length + (state.sessions.length === 1 ? " session" : " sessions") + (live ? " · " + live + " live" : "") + " · updated " + new Date().toLocaleTimeString();
    renderFilters();
    if (state.mode === "evals") {
      await loadEvals();
      await loadEval();
      return;
    }
    renderList();
    if (state.detail) {
      var row = state.sessions.find(function (s) { return s.id === state.selected; });
      var wasLive = state.detail.live;
      if (row && (row.live || wasLive)) {
        await pollTrace();
        if (row.state !== state.detail.state || row.turns !== state.detail.turns || wasLive !== row.live)
          state.detail = await get("/api/sessions/" + state.selected);
        if (wasLive && !row.live && state.tab === "diff") loadDiff();
        renderView();
      }
    }
  } catch (e) {
    conn.textContent = "Disconnected. Run gauge watch again to restart the server.";
  }
}

window.addEventListener("hashchange", route);
renderFilters();
route();
tick();
setInterval(tick, 1500);
