import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  getWatchSession,
  listWatchSessions,
  readWatchDiff,
  readWatchTrace,
} from "./watchData";

export const WATCH_HOST = "127.0.0.1";
export const WATCH_FIRST_PORT = 4040;
export const WATCH_PORT_ATTEMPTS = 50;

const ASSETS: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/logo-for-light.png": ["logo-for-light.png", "image/png"],
  "/logo-for-dark.png": ["logo-for-dark.png", "image/png"],
};

// Bundled into dist/ the assets sit at dist/watch/; from source they sit at src/watch/.
const assetDir = [new URL("./watch/", import.meta.url), new URL("../watch/", import.meta.url)]
  .map((url) => fileURLToPath(url))
  .find((dir) => existsSync(`${dir}index.html`));

export function listenOnFreePort(
  server: Server,
  port = WATCH_FIRST_PORT,
  attempts = WATCH_PORT_ATTEMPTS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (candidate: number, left: number) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && left > 1) tryPort(candidate + 1, left - 1);
        else reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(candidate);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidate, WATCH_HOST);
    };
    tryPort(port, attempts);
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, value: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));

export function createWatchServer(
  gaugeDir: string,
  version: string,
  onRequest: () => void = () => {},
): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    onRequest();
    const port = (req.socket.address() as { port: number }).port;
    // Rejecting foreign Host headers blocks DNS-rebinding pages from reading local traces.
    if (req.headers.host !== `${WATCH_HOST}:${port}` && req.headers.host !== `localhost:${port}`)
      return send(res, 403, "text/plain", "Forbidden");
    if (req.method !== "GET") return send(res, 405, "text/plain", "Method not allowed");
    const url = new URL(req.url ?? "/", `http://${WATCH_HOST}`);
    try {
      const asset = ASSETS[url.pathname];
      if (asset) {
        if (!assetDir) return send(res, 500, "text/plain", "Gauge watch assets are missing; reinstall the CLI.");
        return send(res, 200, asset[1], await readFile(assetDir + asset[0]));
      }
      if (url.pathname === "/api/health")
        return json(res, 200, { gauge: "watch", version, gaugeDir });
      if (url.pathname === "/api/sessions")
        return json(res, 200, { sessions: await listWatchSessions(gaugeDir) });
      const match = /^\/api\/sessions\/([A-Za-z0-9_-]+)(\/trace|\/diff)?$/.exec(url.pathname);
      if (match) {
        const [, id, part] = match;
        if (part === "/diff") {
          const diff = await readWatchDiff(gaugeDir, id);
          return diff === undefined
            ? json(res, 404, { error: "not_found" })
            : send(res, 200, "text/plain; charset=utf-8", diff);
        }
        const after = Number(url.searchParams.get("after") ?? -1);
        const value =
          part === "/trace"
            ? await readWatchTrace(gaugeDir, id, Number.isFinite(after) ? after : -1)
            : await getWatchSession(gaugeDir, id);
        return value ? json(res, 200, value) : json(res, 404, { error: "not_found" });
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, 500, { error: String(error) });
    }
  });
}
