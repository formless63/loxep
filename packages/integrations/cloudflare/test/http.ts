/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Every unit test injects one of these through
 * `createCloudflareAdapter({ fetchImpl })` so the suite exercises the real
 * request/response path — envelope unwrapping, pagination, error
 * normalization, TTL translation — without a live Cloudflare account.
 */
import type { CloudflareAdapterError, CloudflareFetch } from "../src/index.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface StubResponse {
  status?: number;
  /** Parsed JSON body. Wrapped in the envelope by {@link ok} if you want. */
  body?: unknown;
  /** Raw text body; when set, `body` is ignored. */
  text?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export interface FetchStub {
  impl: CloudflareFetch;
  calls: RecordedCall[];
  queryOf(index: number): Record<string, string[]>;
  pathOf(index: number): string;
  bodyOf(index: number): Record<string, unknown>;
}

/** The success envelope Cloudflare wraps every documented response in. */
export function ok(result: unknown, resultInfo?: Record<string, number>): StubResponse {
  return {
    status: 200,
    body: {
      success: true,
      errors: [],
      messages: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    },
  };
}

/** A failure envelope, at whatever HTTP status the caller wants. */
export function fail(
  status: number,
  errors: Array<{
    code: number;
    message: string;
    error_chain?: Array<{ code: number; message: string }>;
  }>,
): StubResponse {
  return {
    status,
    body: { success: false, errors, messages: [], result: null },
  };
}

function toResponse(spec: StubResponse): Response {
  const status = spec.status ?? 200;
  const headers = new Headers(spec.headers ?? {});
  let payload: string;
  if (spec.text !== undefined) {
    payload = spec.text;
    if (spec.contentType !== null) {
      headers.set("content-type", spec.contentType ?? "text/html; charset=UTF-8");
    }
  } else {
    payload = JSON.stringify(spec.body ?? null);
    if (spec.contentType !== null) {
      headers.set(
        "content-type",
        spec.contentType ?? "application/json; charset=UTF-8",
      );
    }
  }
  return new Response(payload, { status, headers });
}

/**
 * `responses` is consumed in order; a function receives the call index and the
 * requested URL so a test can answer pagination dynamically. Running out of
 * scripted responses is a test bug and throws.
 */
export function createFetchStub(
  responses:
    | StubResponse[]
    | ((index: number, url: URL) => StubResponse | Promise<StubResponse>),
): FetchStub {
  const calls: RecordedCall[] = [];

  const impl: CloudflareFetch = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const recorded: Record<string, string> = {};
    headers.forEach((value, key) => {
      recorded[key.toLowerCase()] = value;
    });
    const index = calls.length;
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: recorded,
      body: typeof init.body === "string" ? init.body : null,
    });

    if (typeof responses === "function") {
      return toResponse(await responses(index, parsed));
    }
    const spec = responses[index];
    if (spec === undefined) {
      throw new Error(`fetch stub exhausted at call ${index}`);
    }
    return toResponse(spec);
  };

  return {
    impl,
    calls,
    queryOf(index) {
      const call = calls[index];
      if (call === undefined) throw new Error(`no call at index ${index}`);
      const out: Record<string, string[]> = {};
      new URL(call.url).searchParams.forEach((value, key) => {
        (out[key] ??= []).push(value);
      });
      return out;
    },
    pathOf(index) {
      const call = calls[index];
      if (call === undefined) throw new Error(`no call at index ${index}`);
      return new URL(call.url).pathname;
    },
    bodyOf(index) {
      const call = calls[index];
      if (call === undefined) throw new Error(`no call at index ${index}`);
      if (call.body === null) throw new Error(`call ${index} had no body`);
      return JSON.parse(call.body) as Record<string, unknown>;
    },
  };
}

/** A rejecting stub, for the transport-failure taxonomy tests. */
export function createFailingFetchStub(error: unknown): FetchStub {
  const calls: RecordedCall[] = [];
  const impl: CloudflareFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: {},
      body: null,
    });
    throw error;
  };
  return {
    impl,
    calls,
    queryOf() {
      throw new Error("not applicable");
    },
    pathOf(index) {
      const call = calls[index];
      if (call === undefined) throw new Error(`no call at index ${index}`);
      return new URL(call.url).pathname;
    },
    bodyOf() {
      throw new Error("not applicable");
    },
  };
}

/**
 * Await a promise that must reject with a {@link CloudflareAdapterError}, and
 * return it narrowed. `.catch(e => e)` would union the error with the success
 * type, which makes every subsequent assertion a cast.
 */
export async function rejection(
  promise: Promise<unknown>,
): Promise<CloudflareAdapterError> {
  try {
    await promise;
  } catch (error) {
    return error as CloudflareAdapterError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

export const TEST_TOKEN = "cf_unit_test_api_token_000000000000000000000";
export const TEST_ACCOUNT_ID = "acct_unit_test_0000000000000000";
export const TEST_ZONE_ID = "zone_unit_test_0000000000000000";
export const TEST_ZONE_NAME = "example.test";

/** A provider-shaped zone object, as Cloudflare returns one. */
export function zonePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TEST_ZONE_ID,
    name: TEST_ZONE_NAME,
    status: "active",
    paused: false,
    name_servers: ["ns1.cloudflare.test", "ns2.cloudflare.test"],
    original_name_servers: ["ns1.registrar.test"],
    account: { id: TEST_ACCOUNT_ID, name: "Test Account" },
    ...overrides,
  };
}

/** A provider-shaped DNS record object, as Cloudflare returns one. */
export function recordPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "rec_0000000000000000",
    type: "A",
    name: TEST_ZONE_NAME,
    content: "203.0.113.10",
    ttl: 1,
    proxied: true,
    proxiable: true,
    comment: "operator note",
    tags: [],
    ...overrides,
  };
}
