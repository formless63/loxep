/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Every unit test injects one of these through
 * `createBeszelAdapter({ fetchImpl })` so the suite exercises the real
 * request/response path — the `Authorization` header, the PocketBase paths, the
 * `{page, perPage, totalItems, totalPages, items}` envelope, fact mapping,
 * error normalization — without a live Beszel hub, and without ever making a
 * request.
 *
 * ## Why the default status of {@link fail} is the code you pass
 *
 * Purelymail's equivalent helper defaults to HTTP 200 because that provider
 * reports authentication failures with a success status. PocketBase does not:
 * it answers with the real 4xx and repeats it inside `{status, message, data}`.
 * So here the status IS the interesting variable and it is the first argument,
 * matching Cloudflare's helper.
 *
 * Nothing in this file is a real credential. The marker literals are chosen so
 * a containment assertion over serialized output cannot match by accident.
 */
import type { BeszelFetch } from "../src/index.ts";

/** Distinctive markers: a containment assertion on these cannot false-positive. */
export const TEST_PASSWORD = "zzz-beszel-password-marker-zzz";
export const TEST_TOKEN = "zzz-beszel-authtoken-marker-zzz";
export const TEST_EMAIL = "loxep-readonly@example.invalid";
export const TEST_BASE_URL = "https://beszel.example.invalid";

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased, so a test never depends on the sent casing. */
  headers: Record<string, string>;
  body: string | null;
}

export interface StubResponse {
  status?: number;
  /** Parsed JSON body. */
  body?: unknown;
  /** Raw text body; when set, `body` is ignored. */
  text?: string;
}

export interface FetchStub {
  impl: BeszelFetch;
  calls: RecordedCall[];
  pathOf(index: number): string;
  queryOf(index: number): Record<string, string>;
  bodyOf(index: number): Record<string, unknown>;
  rawBodyOf(index: number): string | null;
}

/** A PocketBase list page. */
export function page(
  items: unknown[],
  overrides: Partial<{
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
  }> = {},
): StubResponse {
  return {
    status: 200,
    body: {
      page: overrides.page ?? 1,
      perPage: overrides.perPage ?? 200,
      totalItems: overrides.totalItems ?? items.length,
      totalPages: overrides.totalPages ?? 1,
      items,
    },
  };
}

/** The login response. Carries a live credential — see `src/redact.ts`. */
export function authOk(token: string = TEST_TOKEN): StubResponse {
  return {
    status: 200,
    body: {
      token,
      record: { id: "u1", email: TEST_EMAIL, role: "readonly" },
    },
  };
}

/** The PocketBase error envelope: `{status, message, data}`. */
export function fail(
  status: number,
  message: string,
  data: Record<string, unknown> = {},
): StubResponse {
  return { status, body: { status, message, data } };
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: BeszelFetch = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : null,
    });

    const response = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (response === undefined) {
      throw new Error("fetch stub ran out of responses");
    }
    const text =
      response.text ??
      (response.body === undefined ? "" : JSON.stringify(response.body));
    return new Response(text, {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
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
    bodyOf: (i) => {
      const raw = calls[i]?.body;
      return raw == null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    },
    rawBodyOf: (i) => calls[i]?.body ?? null,
  };
}

/** A `systems` record in the shape observed field names suggest. */
export function systemRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "sys_aaaaaaaaaaaaaaa",
    name: "web-01",
    host: "10.0.0.11",
    port: "45876",
    status: "up",
    users: ["u1"],
    created: "2026-01-02 03:04:05.000Z",
    updated: "2026-08-13 07:00:00.000Z",
    ...overrides,
  };
}
