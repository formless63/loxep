/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 */
import type { TermixFetch } from "../src/index.ts";

/** Distinctive markers: a containment assertion on these cannot false-positive. */
export const TEST_USERNAME = "loxep-readonly";
export const TEST_PASSWORD = "zzz-termix-password-marker-zzz";
export const TEST_BEARER_TOKEN = "zzz-termix-jwt-marker-zzz";
export const TEST_SESSION_COOKIE = "zzz-termix-cookie-marker-zzz";
export const TEST_BASE_URL = "https://termix.example.invalid";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  setCookie?: string;
}

export interface FetchStub {
  impl: TermixFetch;
  calls: RecordedCall[];
  pathOf(index: number): string;
  bodyOf(index: number): Record<string, unknown>;
}

export function fail(status: number, message: string): StubResponse {
  return { status, body: { message } };
}

/** Login succeeds via the body-token path (no cookie fallback needed). */
export function loginOkWithBodyToken(
  token: string = TEST_BEARER_TOKEN,
): StubResponse {
  return { status: 200, body: { token } };
}

/** Login succeeds but returns no usable body token — sets a session cookie instead. */
export function loginOkCookieOnly(): StubResponse {
  return { status: 200, body: {}, setCookie: `session=${TEST_SESSION_COOKIE}` };
}

export function meTokenOk(token: string = TEST_BEARER_TOKEN): StubResponse {
  return { status: 200, body: { token } };
}

export function hostsPage(hosts: unknown[]): StubResponse {
  return { status: 200, body: hosts };
}

export function statusMap(entries: Record<string, unknown>): StubResponse {
  return { status: 200, body: entries };
}

export function sessionsPage(sessions: unknown[]): StubResponse {
  return { status: 200, body: sessions };
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: TermixFetch = async (url, init) => {
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

    const responseSpec = responses[index] ?? responses[responses.length - 1];
    index += 1;
    if (responseSpec === undefined) {
      throw new Error("fetch stub ran out of responses");
    }
    const text =
      responseSpec.text ??
      (responseSpec.body === undefined ? "" : JSON.stringify(responseSpec.body));
    const responseHeaders: Record<string, string> = {
      "content-type": "application/json",
    };
    if (responseSpec.setCookie !== undefined) {
      responseHeaders["set-cookie"] = responseSpec.setCookie;
    }
    return new Response(text, {
      status: responseSpec.status ?? 200,
      headers: responseHeaders,
    });
  };

  return {
    impl,
    calls,
    pathOf: (i) => new URL(calls[i]!.url).pathname,
    bodyOf: (i) => {
      const raw = calls[i]?.body;
      return raw == null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    },
  };
}

/** An SSH host record in a shape a Termix host-management UI would plausibly use. */
export function hostRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    name: "web-01",
    ip: "10.0.0.11",
    ...overrides,
  };
}

/** An active-session record, per the FULLY-SPECIFIED openapi.json schema. */
export function sessionRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sessionId: "sess-1",
    hostId: 1,
    hostName: "web-01",
    tabInstanceId: "tab-1",
    isConnected: true,
    createdAt: 1_755_000_000_000,
    isOwnSession: true,
    sharedByUsername: null,
    permissionLevel: null,
    shareId: null,
    ...overrides,
  };
}
