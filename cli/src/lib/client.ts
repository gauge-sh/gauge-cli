import { type ErrorCode, errorEnvelopeSchema } from "@withgauge/api-schemas";
import { CLI_VERSION } from "../version";
import { readConfig } from "./config";
import { resolveToken } from "./credentials";

export const DEFAULT_API_URL = "https://agents.withgauge.com";

export { CLI_VERSION };

export const USER_AGENT = `gauge-cli/${CLI_VERSION}`;

export type CliErrorCode = ErrorCode | "usage" | "network";

export function exitCodeFor(code: CliErrorCode): number {
  switch (code) {
    case "usage":
    case "invalid_request":
      return 2;
    case "insufficient_credits":
    case "needs_provider_key":
      return 3;
    default:
      return 1;
  }
}

export type CliErrorOptions = {
  hint?: string;
  docs?: string;
  needsAccount?: boolean;
};

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;
  readonly hint?: string;
  readonly docs?: string;
  readonly needsAccount: boolean;

  constructor(
    code: CliErrorCode,
    message: string,
    options: CliErrorOptions = {},
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCodeFor(code);
    this.hint = options.hint;
    this.docs = options.docs;
    this.needsAccount = options.needsAccount ?? false;
  }
}

export type Query = Record<string, string | number | boolean | undefined>;

export type SseEvent = { event?: string; data: string };

export type ApiClientOptions = {
  baseUrl?: string;
  token?: string | null;
  authOptional?: boolean;
};

export function resolveBaseUrl(): string {
  return process.env.GAUGE_API_URL || readConfig().apiUrl || DEFAULT_API_URL;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | null;
  private readonly authOptional: boolean;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? resolveBaseUrl()).replace(/\/+$/, "");
    this.token = options.token !== undefined ? options.token : resolveToken();
    this.authOptional = options.authOptional ?? false;
  }

  get signedIn(): boolean {
    return this.token !== null;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }

  async patch<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PATCH", path, { body, query });
  }

  async put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("PUT", path, { body, query });
  }

  async delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("DELETE", path, { query });
  }

  async sse(
    path: string,
    onEvent: (event: SseEvent) => void,
    options: {
      query?: Query;
      signal?: AbortSignal;
      onComment?: () => void;
    } = {},
  ): Promise<void> {
    const res = await this.fetch(this.url(path, options.query), {
      method: "GET",
      headers: this.headers({ Accept: "text/event-stream" }),
      signal: options.signal,
    });
    if (!res.ok) throw await this.toError(res);
    if (!res.body) {
      throw new CliError("internal", "Event stream had no response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          const event = parseSseFrame(raw);
          buffer = buffer.slice(boundary + 2);
          if (event) onEvent(event);
          else if (raw.trimStart().startsWith(":")) options.onComment?.();
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw new CliError("network", `Event stream failed: ${messageOf(error)}`);
    }
  }

  private url(path: string, query?: Query): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    if (!this.token && !this.authOptional) {
      throw new CliError(
        "unauthorized",
        "Not logged in. Run `gauge auth login` or set GAUGE_API_TOKEN.",
        { needsAccount: true },
      );
    }
    return {
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      "User-Agent": USER_AGENT,
      Accept: "application/json",
      ...extra,
    };
  }

  private async fetch(url: URL, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new CliError(
        "network",
        `Request to ${url.host} failed: ${messageOf(error)}`,
      );
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Query } = {},
  ): Promise<T> {
    const headers = this.headers(
      options.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    );
    const res = await this.fetch(this.url(path, options.query), {
      method,
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    if (!res.ok) throw await this.toError(res);
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!text) return undefined as T;
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return JSON.parse(text) as T;
    }
    return text as T;
  }

  private async toError(res: Response): Promise<CliError> {
    const wait = res.status === 429 ? retryAfterSeconds(res) : undefined;
    const hint = wait === undefined ? undefined : `Try again in ${wait} s.`;
    try {
      const parsed = errorEnvelopeSchema.safeParse(await res.clone().json());
      if (parsed.success) {
        return new CliError(parsed.data.error.code, parsed.data.error.message, {
          hint,
        });
      }
    } catch {
    }
    const what =
      res.status === 429
        ? "Rate limited by the Gauge API"
        : res.status >= 500
          ? "Gauge API server error"
          : "API request failed";
    return new CliError(
      codeForStatus(res.status),
      `${what}: HTTP ${res.status} ${res.statusText}`.trim(),
      { hint },
    );
  }
}

export function createClient(options?: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}

function retryAfterSeconds(res: Response): number | undefined {
  const value = res.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const at = Date.parse(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function codeForStatus(status: number): CliErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "unauthorized";
    case 402:
      return "insufficient_credits";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "conflict";
    case 429:
      return "rate_limited";
    default:
      return "internal";
  }
}

function parseSseFrame(frame: string): SseEvent | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return { event: eventName, data: dataLines.join("\n") };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return String(error);
}
