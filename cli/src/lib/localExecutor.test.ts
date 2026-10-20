import assert from "node:assert/strict";
import test from "node:test";
import type { SessionStatus } from "@withgauge/local-execution";
import { drive } from "./localExecutor";

test("a question stop records why the session ended", async () => {
  const states: SessionStatus["state"][] = ["blocked", "canceled", "canceled"];
  const stops: string[] = [];
  const result = await drive(
    "session",
    (status, endedBy) => ({ detail: status.detail, endedBy }) as never,
    () => false,
    {
      getSessionStatus: async () =>
        ({ state: states.shift(), turn: 1 }) as SessionStatus,
      stopSession: async (directory) => {
        stops.push(directory);
      },
      finishSession: async () => {
        throw new Error("unexpected finish");
      },
    },
  );
  assert.deepEqual(stops, ["session"]);
  assert.deepEqual(result, {
    detail:
      "Stopped: the agent asked a question, and local runs have no user to answer it",
    endedBy: "supervisor_stop",
  });
});
