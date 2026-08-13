/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Unlike Beszel/PocketBase, Gatus's success bodies are a MIX of JSON
 * (`/api/v1/config`, `/api/v1/endpoints/statuses`, `/health`) and bare
 * `text/plain` (`uptimes/:duration`, `response-times/:duration`), and its
 * FAILURE bodies are ordinarily plain text too (`c.SendString(err.Error())`)
 * rather than a JSON envelope — see `src/errors.ts`'s module doc for the
 * source citations. This stub therefore supports both a `body` (JSON-encoded)
 * and a `text` (sent verbatim) response shape, matching `beszel`'s helper.
 *
 * Every marker literal below is a deliberately fake, non-credential-shaped
 * string — no provider token prefix, no realistic base64 — so a containment
 * assertion over serialized output cannot false-positive AND so nothing here
 * pattern-matches a real secret format.
 */
import type { GatusFetch } from "../src/index.ts";

export const TEST_USERNAME = "zzz-gatus-username-marker-zzz";
export const TEST_PASSWORD = "zzz-gatus-password-marker-zzz";
export const TEST_BASE_URL = "https://gatus.example.invalid";

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased, so a test never depends on the sent casing. */
  headers: Record<string, string>;
}

export interface StubResponse {
  status?: number;
  /** Parsed JSON body. */
  body?: unknown;
  /** Raw text body; when set, `body` is ignored. */
  text?: string;
}

export interface FetchStub {
  impl: GatusFetch;
  calls: RecordedCall[];
  pathOf(index: number): string;
  queryOf(index: number): Record<string, string>;
}

/** `GET /api/v1/config`'s body. */
export function configProbe(
  oidc: boolean,
  authenticated: boolean,
): StubResponse {
  return { status: 200, body: { oidc, authenticated } };
}

/** `GET /health`'s body (`github.com/TwiN/health`, `WithJSON(true)`). */
export function health(status: "UP" | "DOWN" = "UP", reason?: string): StubResponse {
  return {
    status: status === "UP" ? 200 : 500,
    body: { status, ...(reason === undefined ? {} : { reason }) },
  };
}

/** One `Result` (`config/endpoint/result.go`) inside a status's `results`. */
export function resultEntry(
  overrides: Partial<{
    status: number;
    success: boolean;
    timestamp: string;
    errors: string[];
  }> = {},
): Record<string, unknown> {
  return {
    status: overrides.status ?? 200,
    success: overrides.success ?? true,
    timestamp: overrides.timestamp ?? "2026-08-13T07:00:00Z",
    duration: 12_000_000,
    ...(overrides.errors === undefined ? {} : { errors: overrides.errors }),
  };
}

/** One `Status` (`config/endpoint/status.go`). */
export function endpointStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key: "core_loxep",
    name: "Loxep",
    group: "core",
    results: [resultEntry()],
    ...overrides,
  };
}

/** `GET /api/v1/endpoints/statuses`'s body — a bare JSON array. */
export function endpointStatuses(items: unknown[]): StubResponse {
  return { status: 200, body: items };
}

/** `GET .../uptimes/:duration`'s body — `text/plain`, a bare `%f` fraction. */
export function uptimeText(value: number): StubResponse {
  return { status: 200, text: value.toFixed(6) };
}

/** `GET .../response-times/:duration`'s body — `text/plain`, a bare `%d` ms. */
export function responseTimeText(value: number): StubResponse {
  return { status: 200, text: String(Math.trunc(value)) };
}

/** A failure response with Gatus's ordinary plain-text body. */
export function fail(status: number, text: string): StubResponse {
  return { status, text };
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: GatusFetch = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({ url, method: init.method ?? "GET", headers });

    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (response === undefined) {
      throw new Error("fetch stub ran out of responses");
    }
    const text =
      response.text ??
      (response.body === undefined ? "" : JSON.stringify(response.body));
    return new Response(text, { status: response.status ?? 200 });
  };

  const urlOf = (i: number): URL => {
    const call = calls[i];
    if (call === undefined) throw new Error(`no recorded call at index ${i}`);
    return new URL(call.url);
  };

  return {
    impl,
    calls,
    pathOf: (i) => urlOf(i).pathname,
    queryOf: (i) => Object.fromEntries(urlOf(i).searchParams.entries()),
  };
}
