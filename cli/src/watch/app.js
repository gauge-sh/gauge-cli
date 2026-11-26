"use strict";
var STATUSES = [["all", "All"], ["running", "Running"], ["completed", "Completed"], ["failed", "Failed"], ["unavailable", "Unavailable"]];
var state = { sessions: [], filter: "all", query: "", selected: null, detail: null, tab: "trace",
  events: [], inputs: [], lastSeq: -1, diff: null, diffOpen: {}, traceToken: 0, promptOpen: false, sessionsJson: "" };

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

function stamp(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
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

function icon(path, size) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
}
var FUNNEL = icon('<path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z"/>', 13);
var CHEVRON = icon('<path d="M4 6l4 4 4-4"/>', 12);
var SEARCH = icon('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>', 14);

function params() {
  var p = new URLSearchParams();
  if (state.filter !== "all") p.set("status", state.filter);
  if (state.query) p.set("q", state.query);
  var q = p.toString();
  return q ? "?" + q : "";
}
function go(path) { location.hash = path + params(); }
function syncUrl() { history.replaceState(null, "", "#" + (location.hash.slice(1).split("?")[0] || "/") + params()); }

function matches(s, status) {
  if (status === "running") return s.live;
  if (status === "completed") return s.state === "completed";
  if (status === "unavailable") return s.state === "unavailable";
  if (status === "failed") return s.state === "failed" || s.state === "interrupted" || s.state === "canceled";
  return true;
}

function renderFilters() {
  var box = document.getElementById("filters");
  if (!box.firstChild) {
    var input = h("input", { id: "q", placeholder: "Search sessions" });
    input.addEventListener("input", function () { state.query = input.value; syncUrl(); renderList(); });
    var menu = h("div", { id: "status-menu", class: "menu", hidden: "" });
    var button = h("button", { id: "status", title: "Filter by status", onclick: function (e) { e.stopPropagation(); menu.hidden = !menu.hidden; } });
    document.addEventListener("click", function (e) { if (!menu.contains(e.target)) menu.hidden = true; });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") menu.hidden = true; });
    button.innerHTML = FUNNEL + '<span class="label"></span>' + CHEVRON;
    var glass = h("span", { class: "glass" });
    glass.innerHTML = SEARCH;
    STATUSES.forEach(function (f) {
      menu.appendChild(h("button", { "data-status": f[0], onclick: function () {
        state.filter = f[0]; menu.hidden = true; syncUrl(); renderFilters(); renderList();
      } }, h("span", { class: "check" }), f[1], h("span", { class: "count" })));
    });
    box.appendChild(h("div", { class: "search", onclick: function (e) { if (e.target === this) input.focus(); } }, glass, button, input, menu));
  }
  var q = document.getElementById("q");
  if (q.value !== state.query) q.value = state.query;
  var button = document.getElementById("status");
  var active = STATUSES.find(function (f) { return f[0] === state.filter; });
  button.className = "status-btn" + (state.filter !== "all" ? " on" : "");
  button.querySelector(".label").textContent = state.filter === "all" ? "Status" : active[1];
  document.querySelectorAll("#status-menu button").forEach(function (item) {
    var status = item.dataset.status;
    item.className = state.filter === status ? "on" : "";
    item.querySelector(".check").textContent = state.filter === status ? "✓" : "";
    item.querySelector(".count").textContent = String(state.sessions.filter(function (s) { return matches(s, status); }).length);
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
    if (!matches(s, state.filter)) return false;
    if (!state.query) return true;
    return [s.case, s.agent, agentName(s.agent), s.model, s.id, s.batchId].join(" ").toLowerCase().indexOf(state.query.toLowerCase()) >= 0;
  });
}

function renderList() {
  var list = document.getElementById("list");
  var scroll = list.scrollTop;
  list.textContent = "";
  var rows = visible();
  if (!rows.length) {
    list.appendChild(h("div", { class: "empty", style: "padding:24px" }, state.sessions.length ? "No sessions match." : "No sessions yet. Start one with gauge run."));
    return;
  }
  var batches = {}, order = [];
  rows.forEach(function (s) {
    if (!batches[s.batchId]) { batches[s.batchId] = []; order.push(s.batchId); }
    batches[s.batchId].push(s);
  });
  order.forEach(function (batch) {
    list.appendChild(h("div", { class: "batch" }, "Batch " + batch.slice(0, 8)));
    batches[batch].forEach(function (s) { list.appendChild(renderRow(s)); });
  });
  list.scrollTop = scroll;
}

function renderRow(s) {
  var name = s.case ? splitCase(s.case) : ["", s.id];
  var stats = [s.state === "completed" ? null : s.state, s.turns ? turns(s.turns) : null, s.live ? null : duration(s.durationMs)].filter(Boolean).join(" · ");
  var who = [agentName(s.agent), s.model].filter(Boolean).join(" · ");
  return h("div", { class: "row" + (s.id === state.selected ? " sel" : ""), title: s.case || s.id, onclick: function () { go("#/session/" + s.id); } },
    h("span", { class: "dot " + stateClass(s) }),
    h("span", { class: "case" }, name[1]),
    h("span", { class: "age", title: s.createdAt ? "Started " + new Date(s.createdAt).toLocaleString() : "" }, stamp(s.createdAt)),
    h("span", { class: "meta" }, who || "\u00a0"),
    h("span", { class: "meta" }, stats || "\u00a0"));
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
    ["Last known state", s.lastKnownState],
    ["Agent", agentName(s.agent)], ["Model", s.model], ["Turns", String(s.turns)],
    ["Duration", s.durationMs != null ? duration(s.durationMs) : null],
    ["Tokens", u.seen ? compact(u.input) + " in / " + compact(u.output) + " out" : s.inputTokens != null ? compact(s.inputTokens) + " in / " + compact(s.outputTokens || 0) + " out" : null],
    ["Measurement", s.measurement ? s.measurement.kind + " r" + s.measurement.revision : null],
    ["Sample", s.sample != null ? String(s.sample) : null],
    ["Started", s.createdAt ? new Date(s.createdAt).toLocaleString() : null],
    ["Run", s.id],
  ];
  var grid = h("dl", { class: "meta-grid" });
  fields.forEach(function (f) { if (f[1]) grid.appendChild(h("div", null, h("dt", null, f[0]), h("dd", { class: f[2] || "" }, f[1]))); });
  view.appendChild(h("div", { class: "head" },
    h("h2", null, h("span", { class: "dot " + stateClass(s) }), h("span", null, h("span", { class: "dir" }, name[0]), name[1])),
    s.prompt ? h("div", { class: "prompt" + (state.promptOpen ? " open" : "") },
      h("div", { class: "text" }, s.prompt),
      h("button", { class: "more", onclick: function () { state.promptOpen = !state.promptOpen; renderView(); } }, state.promptOpen ? "Show less" : "Show more")) : null,
    grid,
    s.detail && !s.live && s.state !== "completed" ? h("div", { class: "detail" }, s.detail) : null));
  var tabs = h("div", { class: "tabs" });
  [["trace", "Trace"], ["task", "Task"], ["diff", "Diff"]].forEach(function (t) {
    tabs.appendChild(h("button", { class: state.tab === t[0] ? "on" : "", onclick: function () { go("#/session/" + state.selected + "/" + t[0]); } }, t[1]));
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
  var results = {}, calls = {};
  state.events.forEach(function (e) {
    if (!e.payload) return;
    if (e.payload.type === "tool_result") results[e.payload.tool_id] = e;
    else if (e.payload.type === "tool_call") calls[e.payload.tool_id] = true;
  });
  var items = [];
  state.inputs.forEach(function (i, n) {
    if (n === 0 && state.detail && typeof i.text === "string" && i.text.trim() === (state.detail.prompt || "").trim()) return;
    items.push({ at: i.observedAt, order: -1, input: i }); });
  state.events.forEach(function (e) {
    var p = e.payload || {};
    if (p.type === "tool_result" && p.tool_id && calls[p.tool_id]) return;
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
      h("div", { class: "out" }, "⎿ " + (r ? firstLine(r.output) : state.detail.live ? "running…" : state.detail.state === "unavailable" ? "(status unavailable)" : "(no result)")),
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
  if (!items.length) body.appendChild(h("div", { class: "pending" }, state.detail.live ? "Waiting for the agent's first event…" : state.detail.state === "unavailable" ? "No trace events available yet. Session status is unavailable." : "This session recorded no trace events."));
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
  if (!state.diff) return body.appendChild(h("div", { class: "pending" }, state.detail.live ? "The diff is written when the session ends." : state.detail.state === "unavailable" ? "No diff available yet. Session status is unavailable." : "No diff."));
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

function renderView() {
  if (state.page === "repositories") return;
  var view = document.getElementById("view");
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
  var prompt = view.querySelector(".prompt:not(.open) .text");
  if (prompt && prompt.scrollHeight <= prompt.clientHeight + 1) view.querySelector(".prompt .more").remove();
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
  if (id !== state.selected || token !== state.traceToken) return false;
  var fresh = t.events.filter(function (e) { return e.seq > state.lastSeq; });
  if (fresh.length) {
    state.events = state.events.concat(fresh);
    state.lastSeq = fresh[fresh.length - 1].seq;
  }
  var changed = fresh.length > 0 || t.inputs.length !== state.inputs.length;
  state.inputs = t.inputs;
  return changed;
}

async function select(id) {
  state.selected = id;
  state.detail = null; state.promptOpen = false; state.events = []; state.inputs = []; state.lastSeq = -1; state.diff = null; state.traceToken++;
  renderList(); renderView();
  if (!id) return;
  try {
    var detail = await get("/api/sessions/" + id);
    if (id !== state.selected) return;
    state.detail = detail;
    await pollTrace();
    if (id !== state.selected) return;
    if (state.tab === "diff") loadDiff();
  } catch (e) {
    if (id !== state.selected) return;
    state.detail = null;
    document.getElementById("view").textContent = "";
    document.getElementById("view").appendChild(h("div", { class: "empty" }, "Session " + id + " was not found."));
    return;
  }
  renderView();
  var body = document.querySelector(".body");
  if (body && state.detail.live) body.scrollTop = body.scrollHeight;
}

var repositoryToken = 0;

function repositoryTable(headers, rows) {
  var table = h("table", { class: "repo-table" });
  var head = h("tr");
  headers.forEach(function (label) { head.appendChild(h("th", { scope: "col" }, label)); });
  table.appendChild(h("thead", null, head));
  var body = h("tbody");
  rows.forEach(function (cells) {
    var row = h("tr");
    cells.forEach(function (cell) { row.appendChild(h("td", null, cell)); });
    body.appendChild(row);
  });
  table.appendChild(body);
  return h("div", { class: "repo-table-scroll" }, table);
}

function repositoryLink(url, name) {
  try {
    var parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:")
      return h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, name || parsed.pathname.replace(/^\//, "").replace(/\.git$/, ""));
  } catch (e) {}
  return h("span", null, name || url);
}

async function repositorySection(element, endpoint, render) {
  element.textContent = "Loading…";
  try {
    var data = await get("/api/repositories/" + endpoint);
    if (!element.isConnected) return;
    element.textContent = "";
    render(element, data);
  } catch (e) {
    if (!element.isConnected) return;
    element.textContent = "Could not load repository data. ";
    element.appendChild(h("button", { onclick: function () { repositorySection(element, endpoint, render); } }, "Retry"));
  }
}

function renderLanguagePie(element, data, bytes) {
  var sum = data.languages.reduce(function (total, language) { return total + language.value; }, 0);
  element.appendChild(h("p", { class: "repo-note" }, data.recorded + " of " + data.total + " repositories have recorded " + (bytes ? "language bytes." : "languages. Slice percentages show the share of language occurrences.")));
  if (!sum) { element.appendChild(h("p", null, "No language data available.")); return; }
  var stops = [], offset = 0;
  var legend = h("ul", { class: "pie-legend" });
  data.languages.forEach(function (language) {
    var hash = 0;
    for (var i = 0; i < language.name.length; i++) hash = (hash * 31 + language.name.charCodeAt(i)) | 0;
    var color = "hsl(" + ((hash >>> 0) % 360) + " 60% 52%)";
    var end = offset + language.value / sum * 100;
    stops.push(color + " " + offset + "% " + end + "%");
    offset = end;
    var label = language.name + " — " + language.value.toLocaleString() + (bytes ? " bytes" : " repos") + " (" + (language.value / sum * 100).toFixed(1) + "% of chart)";
    if (!bytes && data.total) label += ", " + (language.value / data.total * 100).toFixed(1) + "% of tracked repos";
    legend.appendChild(h("li", null, h("span", { class: "pie-key", style: "background:" + color }), label));
  });
  element.appendChild(h("div", { class: "pie-layout" }, h("div", { class: "repo-pie", role: "img", "aria-label": bytes ? "Language bytes distribution, values in accompanying legend" : "Language occurrence distribution, values in accompanying legend", style: "background:conic-gradient(" + stops.join(",") + ")" }), legend));
}

function discoveryDiagram() {
  function box(kind, title, description) {
    return h("details", { class: "discovery-box discovery-" + kind },
      h("summary", null, title), h("p", null, description));
  }
  function arrow(direction) {
    return h("span", { class: "discovery-arrow discovery-arrow-" + (direction === "↓" ? "down" : direction === "←" ? "left" : "right"), "aria-hidden": "true" });
  }
  function row(left, phase, right, last, input) {
    var center = h("div", { class: "discovery-center" }, phase);
    if (!last) center.appendChild(arrow("↓"));
    return h("div", { class: "discovery-row" },
      h("div", { class: "discovery-left" }, left, arrow(input ? "→" : "←")),
      center,
      h("div", { class: "discovery-right" }, arrow("→"), right));
  }
  var workers = h("div", { class: "discovery-workers" });
  ["1", "2", "…"].forEach(function (number) {
    workers.appendChild(h("div", { class: "discovery-worker" },
      box("phase", "Subagent " + number, "Receive one full README, the run ID, repository URL, README hash, and assigned output path. Write a structured summary of purpose, objectives, intended use, audience, and application type."),
      arrow("→"),
      box("file", "Summary JSON", "summaries/<hash-of-lowercase-repo-url>.json — One file per repository. Validate its schema, run ID, URL, and README hash before using it for grouping.")));
  });
  var flow = h("div", { class: "discovery-flow", "aria-label": "Canonical repository discovery workflow" },
    row(
      box("file", "examples.jsonl", "Collected READMEs and repository metadata. Deduplicate by repository URL and freeze the sample. Pass each README to a subagent, and pass this file to publication to preserve source metadata."),
      box("phase", "Collect repositories from GitHub using the GitHub API", "Start with the technology definition, qualifying usage, and sample target. Plan a finite search budget, search and enrich pages, and freeze the eligible sample. Eligible repositories are public, have a nonempty README, and have at least 20 commits."),
      h("div", { class: "discovery-commands" },
        box("command", "gauge canonical-repos searchGithubExampleCandidates", 'Search one page using a concrete usage signature. Command: gauge canonical-repos searchGithubExampleCandidates --query "<usage signature and qualifiers>" --page 1'),
        box("command", "gauge canonical-repos getGithubExamples", "Enrich candidate names with README and repository metadata. Command: gauge canonical-repos getGithubExamples --file names.json --output-file examples.jsonl"))),
    row(
      box("file", "examples.jsonl", "Input to the parallel subagents. Give each worker one frozen repository's full README and the same summary instructions."),
      box("phase", "Use parallel subagents to turn READMEs into a comparable structure", "Run as many ephemeral subagents in parallel as the environment allows, one README per assignment. Describe purpose and use in technology-neutral terms. Reuse validated summaries and replace missing or stale ones."),
      workers, false, true),
    row(
      box("file", "canonicals.json", "The group definitions passed to publication. Save the full list after each revision, initially with Readme set to null. Every frozen repository must have exactly one group assignment."),
      box("phase", "Define groups of repositories based on common intent", "Use the summaries to group shared user tasks and desired outcomes into 5–10 nonempty groups. Present the membership and sample shares for review. Obtain explicit user approval before drafting READMEs or publishing. A list-only request ends here."),
      h("div", { class: "discovery-approval" }, "User approval before publication")),
    row(
      box("file", ".gauge/gauge.sqlite", "The permanent local catalog. Successful publication saves canonical names, URLs and descriptions, shared source metadata, and associations in canonical_repos, source_repos, and canonical_repo_sources."),
      box("phase", "Create GitHub repositories for each defined group and save them in the local store", "Draft an original README for each approved group, describing its users, objectives, and representative workflow. Apply publication review, publish one group at a time, report the URLs, and remove the completed run's temporary directory."),
      box("command", "gauge canonical-repos flush-canonical-repos", 'Publish one approved group and save it locally. Command: gauge canonical-repos flush-canonical-repos --file canonicals.json --name "<one approved group name>" --examples-file examples.jsonl'), true));
  return h("div", { class: "discovery-section" },
    h("hr"), h("h2", null, "Canonical Repository Workflow"),
    h("p", { class: "repo-note" }, "Run ", h("code", null, "gauge instructions canonical-repo-discovery"), " to teach your agent how to run this workflow."),
    h("div", { class: "discovery-legend" }, h("span", { class: "discovery-phase" }, "Phases and subagents"), h("span", { class: "discovery-command" }, "Commands"), h("span", { class: "discovery-file" }, "Files")),
    h("div", { class: "discovery-scroll", tabindex: "0", role: "region", "aria-label": "Scrollable discovery diagram" }, flow));
}

function showRepositories(page) {
  var view = document.getElementById("view");
  var token = ++repositoryToken;
  view.textContent = "";
  var canonical = h("div"), counts = h("div"), bytes = h("div", null, "Waiting for language counts…"), sources = h("div");
  view.appendChild(h("div", { class: "repositories-page" },
    h("h1", null, "Canonical repositories"),
    h("p", { class: "repo-note" }, "Explore canonical repositories and the tracked repositories associated with each one. Share of voice is the percentage of all tracked repositories associated with a canonical repository, higher share of voice means signals more important or common. A tracked repository can be associated with more than one canonical repository."),
    canonical,
    h("div", { class: "language-charts" },
      h("div", null, h("h2", null, "Repositories by language"), counts),
      h("div", null, h("h2", null, "Code bytes by language"), bytes)), sources, discoveryDiagram()));
  repositorySection(canonical, "canonical", function (element, data) {
    if (!data.repositories.length) { element.textContent = "No canonical repositories recorded."; return; }
    element.appendChild(repositoryTable(["Name", "Description", "Associated repositories", "Share of voice"], data.repositories.map(function (repo) {
      return [repositoryLink(repo.url, repo.name), repo.description, String(repo.count), repo.share.toFixed(1) + "%"];
    })));
  });
  repositorySection(counts, "language-counts", function (element, data) { renderLanguagePie(element, data, false); }).then(function () {
    // Give the first chart a paint before starting the heavier byte aggregation.
    requestAnimationFrame(function () { setTimeout(function () {
      if (token === repositoryToken && state.page === "repositories")
        repositorySection(bytes, "language-bytes", function (element, data) { renderLanguagePie(element, data, true); });
    }, 0); });
  });
  repositorySection(sources, "sources?page=" + page, function (element, data) {
    element.appendChild(h("h2", null, h("strong", null, data.total.toLocaleString() + " total repos tracked")));
    element.appendChild(h("p", { class: "repo-note" }, "Real-life, publicly available repositories that this study is based on."));
    element.appendChild(repositoryTable(["Name", "Commits", "Language bytes"], data.repositories.map(function (repo) {
      return [repositoryLink(repo.url), repo.commits == null ? "Unknown" : String(repo.commits), h("code", { class: "language-json" }, repo.languageBytes == null ? "Unknown" : repo.languageBytes)];
    })));
    var pages = Math.max(1, Math.ceil(data.total / data.pageSize));
    var pagination = h("div", { class: "repo-pagination" });
    if (data.page > 1) pagination.appendChild(h("a", { href: "#/canonical-repositories?page=" + (data.page - 1) }, "Previous"));
    pagination.appendChild(h("span", null, "Page " + data.page + " of " + pages));
    if (data.page < pages) pagination.appendChild(h("a", { href: "#/canonical-repositories?page=" + (data.page + 1) }, "Next"));
    element.appendChild(pagination);
  });
}

function route() {
  var parts = location.hash.split("?");
  var p = new URLSearchParams(parts[1] || "");
  state.page = parts[0] === "#/canonical-repositories" ? "repositories" : "sessions";
  document.body.classList.toggle("show-repositories", state.page === "repositories");
  document.getElementById("sessions-nav").setAttribute("aria-current", state.page === "sessions" ? "page" : "false");
  document.getElementById("repositories-nav").setAttribute("aria-current", state.page === "repositories" ? "page" : "false");
  if (state.page === "repositories") {
    state.selected = null; state.detail = null; state.traceToken++;
    stale = false; listStale = false;
    var page = Number(p.get("page") || 1);
    showRepositories(Number.isSafeInteger(page) && page > 0 ? page : 1);
    return;
  }
  repositoryToken++;
  var status = p.get("status");
  state.filter = STATUSES.some(function (f) { return f[0] === status; }) ? status : "all";
  state.query = p.get("q") || "";
  renderFilters(); renderList();
  var m = /^#\/session\/([A-Za-z0-9_-]+)(?:\/(trace|task|diff))?$/.exec(parts[0]);
  if (m && m[2]) state.tab = m[2];
  if (m && m[1] === state.selected) { if (state.tab === "diff") loadDiff(); renderView(); return; }
  select(m ? m[1] : null);
}

async function tick() {
  var conn = document.getElementById("conn");
  try {
    var raw = await get("/api/sessions", "text");
    if (raw !== state.sessionsJson) {
      state.sessionsJson = raw;
      state.sessions = JSON.parse(raw).sessions;
      var live = state.sessions.filter(function (s) { return s.live; }).length;
      conn.textContent = state.sessions.length + (state.sessions.length === 1 ? " session" : " sessions") + (live ? " · " + live + " live" : "");
      renderFilters();
      listStale = true;
    }
    if (state.page === "sessions" && state.detail) {
      var row = state.sessions.find(function (s) { return s.id === state.selected; });
      var wasLive = state.detail.live;
      var id = state.selected;
      if (row && (row.live || wasLive || row.state === "unavailable" || state.detail.state === "unavailable")) {
        var changed = await pollTrace();
        if (id !== state.selected) return;
        if (row.state !== state.detail.state || row.lastKnownState !== state.detail.lastKnownState || row.turns !== state.detail.turns || wasLive !== row.live) {
          var detail = await get("/api/sessions/" + id);
          if (id !== state.selected) return;
          state.detail = detail;
          changed = true;
        }
        if (row.state !== "unavailable" && !row.live && state.tab === "diff") loadDiff();
        if (changed) stale = true;
      }
    }
    flush();
  } catch (e) {
    state.sessionsJson = "";
    conn.textContent = "Disconnected. Run gauge watch again to restart the server.";
  }
}

function flush() {
  if (pressing || state.page === "repositories") return;
  if (listStale) { listStale = false; renderList(); }
  if (stale) { stale = false; renderView(); }
}

async function poll() {
  await tick();
  setTimeout(poll, state.sessions.some(function (s) { return s.live; }) ? 3000 : 10000);
}

// Rebuilding the list between mousedown and mouseup swallows the click.
var pressing = false, stale = false, listStale = false;
document.addEventListener("mousedown", function () { pressing = true; }, true);
document.addEventListener("mouseup", function () { setTimeout(function () { pressing = false; flush(); }); }, true);
window.addEventListener("hashchange", route);
renderFilters();
route();
poll();
