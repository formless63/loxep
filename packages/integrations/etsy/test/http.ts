/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Every unit test injects one of these through `createEtsyAdapter({
 * fetchImpl })` (or directly as `oauth.ts`'s `fetchImpl`) so the suite
 * exercises the real request/response path — headers, body parsing, error
 * normalization — without touching Etsy at all. Mirrors
 * `packages/integrations/invoiceninja/test/http.ts` structurally.
 */
import type { EtsyAdapterError, EtsyFetch } from "../src/index.ts";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export interface FetchStub {
  impl: EtsyFetch;
  calls: RecordedCall[];
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
      headers.set("content-type", spec.contentType ?? "application/json; charset=UTF-8");
    }
  }
  return new Response(payload, { status, headers });
}

/**
 * `responses` is consumed in order; a function receives the call index and
 * the requested URL so a test can answer pagination dynamically. Running out
 * of scripted responses is a test bug and throws.
 */
export function createFetchStub(
  responses:
    | StubResponse[]
    | ((index: number, url: URL) => StubResponse | Promise<StubResponse>),
): FetchStub {
  const calls: RecordedCall[] = [];

  const impl: EtsyFetch = async (url, init) => {
    const parsed = new URL(url);
    const headers = new Headers(init.headers);
    const recorded: Record<string, string> = {};
    headers.forEach((value, key) => {
      recorded[key.toLowerCase()] = value;
    });
    const index = calls.length;
    let body: unknown = undefined;
    if (typeof init.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init.method ?? "GET", headers: recorded, body });

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
  const impl: EtsyFetch = async (url, init) => {
    calls.push({ url, method: init.method ?? "GET", headers: {}, body: undefined });
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
 * Await a promise that must reject with an {@link EtsyAdapterError}, and
 * return the error narrowed.
 */
export async function rejection(promise: Promise<unknown>): Promise<EtsyAdapterError> {
  try {
    await promise;
  } catch (error) {
    return error as EtsyAdapterError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

export const TEST_KEYSTRING = "loxeptestkeystring0000000000000000";
export const TEST_SHARED_SECRET = "loxeptestsharedsecret000000000000";
