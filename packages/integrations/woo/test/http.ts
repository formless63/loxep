/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Every unit test injects one of these through `createWooAdapter({ fetchImpl })`
 * so the suite exercises the real request/response path — header parsing,
 * error normalization, pagination — without a live store.
 */
import type { WooAdapterError, WooFetch } from "../src/index.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Raw text body; when set, `body` is ignored and `contentType` applies. */
  text?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export interface FetchStub {
  impl: WooFetch;
  calls: RecordedCall[];
  /** Query parameters of call `index`, as a plain object (arrays joined). */
  queryOf(index: number): Record<string, string[]>;
  pathOf(index: number): string;
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

  const impl: WooFetch = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const recorded: Record<string, string> = {};
    headers.forEach((value, key) => {
      recorded[key.toLowerCase()] = value;
    });
    const index = calls.length;
    calls.push({ url, method: init.method ?? "GET", headers: recorded });

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
  };
}

/** A rejecting stub, for the transport-failure taxonomy tests. */
export function createFailingFetchStub(error: unknown): FetchStub {
  const calls: RecordedCall[] = [];
  const impl: WooFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? "GET", headers: {} });
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
  };
}

/**
 * Await a promise that must reject with a {@link WooAdapterError}, and return
 * the error narrowed. `.catch(e => e)` would union the error with the success
 * type, which makes every subsequent assertion a cast.
 */
export async function rejection(
  promise: Promise<unknown>,
): Promise<WooAdapterError> {
  try {
    await promise;
  } catch (error) {
    return error as WooAdapterError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

export const TEST_BASE_URL = "https://shop.example.invalid";
export const TEST_KEY = "ck_unit_test_consumer_key_0000000000000000";
export const TEST_SECRET = "cs_unit_test_consumer_secret_00000000000";
