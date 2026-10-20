import { runTelemetryWorker, sendTelemetry } from "./lib/telemetrySend";

await runTelemetryWorker(async () => {
  const event = JSON.parse(process.argv[2]);
  if (
    typeof event?.command !== "string" ||
    event.command.length > 200 ||
    !/^[a-z0-9-]+(?: [a-z0-9-]+)*$/.test(event.command) ||
    typeof event.timestamp !== "string" ||
    !Number.isFinite(Date.parse(event.timestamp)) ||
    typeof event.cliVersion !== "string" ||
    event.cliVersion.length > 80
  )
    return;
  await sendTelemetry(event);
});
