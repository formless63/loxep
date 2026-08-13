/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 */
import type { TailscaleFetch } from "../src/index.ts";

/** Distinctive markers: a containment assertion on these cannot false-positive. */
export const TEST_API_ACCESS_TOKEN = "tskey-api-zzz-marker-zzz";
export const TEST_OAUTH_CLIENT_ID = "kZZZMARKERCNTRL";
export const TEST_OAUTH_CLIENT_SECRET = "tskey-client-zzz-marker-zzz";
export const TEST_OAUTH_ACCESS_TOKEN = "zzz-oauth-access-token-marker-zzz";
export const TEST_BASE_URL = "https://api.tailscale.example.invalid";
export const TEST_TAILNET = "example.com";

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  body: string | null;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
}

export interface FetchStub {
  impl: TailscaleFetch;
  calls: RecordedCall[];
  pathOf(index: number): string;
  queryOf(index: number): Record<string, string>;
}

export function fail(status: number, message: string): StubResponse {
  return { status, body: { message } };
}

export function oauthTokenOk(
  accessToken: string = TEST_OAUTH_ACCESS_TOKEN,
): StubResponse {
  return { status: 200, body: { access_token: accessToken, expires_in: 3600 } };
}

export function devicesPage(devices: unknown[]): StubResponse {
  return { status: 200, body: { devices } };
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: TailscaleFetch = async (url, init) => {
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
  };
}

/** A `Device` record in the shape the Go client's struct documents. */
export function deviceRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "12345",
    nodeId: "n123456CNTRL",
    name: "web-01.tailnet-name.ts.net",
    hostname: "web-01",
    addresses: ["100.64.0.1"],
    connectedToControl: true,
    os: "linux",
    authorized: true,
    user: "ops@example.com",
    ...overrides,
  };
}
