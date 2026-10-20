import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runLocal } from "./lib/localExecutor";

const requestPath = process.argv[2];
const directory = dirname(requestPath);
let requestLoaded = false;
try {
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  if (
    !request ||
    typeof request.batchId !== "string" ||
    typeof request.gaugeDir !== "string" ||
    !request.definition
  )
    throw new Error("Invalid batch request");
  requestLoaded = true;
  await rm(requestPath);
  await runLocal(request.definition, [], request.gaugeDir, () => {}, {
    batchId: request.batchId,
    credentialSelections: request.credentialSelections,
    measurement: request.measurement,
  });
} catch (error) {
  process.exitCode = 1;
  const detail = requestLoaded
    ? String(error)
    : "Could not read a valid background batch request. Start a new batch.";
  console.error(detail);
  const statusPath = join(directory, "status.json");
  const previous = await readFile(statusPath, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => ({}));
  const finishedSessions = previous.finishedSessions ?? 0;
  const status = {
    ...previous,
    state: "failed",
    detail,
    finishedSessions,
    queuedSessions: 0,
    skippedSessions: Math.max(
      0,
      (previous.expectedSessions ?? 0) - finishedSessions,
    ),
    supervisorPid: process.pid,
  };
  const temporary = `${statusPath}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, statusPath);
  await writeFile(join(directory, "error.txt"), detail, { mode: 0o600 });
}
