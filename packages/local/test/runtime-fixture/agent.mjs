#!/usr/bin/env node
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const session_id = randomUUID();
const emit = (record) => process.stdout.write(JSON.stringify({ session_id, ...record }) + "\n");
let turns = 0;
const complete = (text, error = false) => {
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: error, result: text });
};
for await (const line of createInterface({ input: process.stdin })) {
  const record = JSON.parse(line);
  if (record.type === "control_response") { complete(JSON.stringify(record.response.response)); continue; }
  if (record.type !== "user") continue;
  turns++;
  const text = record.message.content.split("\n\nPrepared inputs:")[0];
  if (text === "CHECK_INPUTS") {
    const note = readFileSync("/gauge/session/resources/docs/content/note.txt", "utf8");
    const skill = readFileSync(`${process.env.CLAUDE_CONFIG_DIR}/skills/skill/SKILL.md`, "utf8");
    const tool = execFileSync("gauge-fixture-tool", [], { encoding: "utf8" }).trim();
    writeFileSync("input-check.txt", JSON.stringify({ note, skill, tool }));
    complete("inputs verified"); continue;
  }
  if (text === "HANG") continue;
  if (text === "FAIL") { complete("fixture agent failed", true); continue; }
  if (text === "QUESTION") {
    emit({ type: "control_request", request_id: "ask-1", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Which color?", header: "Color", options: [{ label: "blue", description: "Blue" }] }] } } });
    continue;
  }
  if (text === "CHECK_BOUNDARY") {
    complete(process.env.GAUGE_HOST_STATE || "no host state exposed");
    continue;
  }
  writeFileSync("hello.txt", "hi\n");
  await new Promise((r) => setTimeout(r, 250));
  complete(`turn ${turns}: ${text}`);
}
