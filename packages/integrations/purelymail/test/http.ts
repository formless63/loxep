/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Every unit test injects one of these through
 * `createPurelymailAdapter({ fetchImpl })` so the suite exercises the real
 * request/response path — the token header, the RPC path, the `{type, result}`
 * envelope, fact mapping, error normalization — without a live Purelymail
 * account, and without ever making a request.
 *
 * ## Why the default status of {@link fail} is 200
 *
 * Cloudflare's equivalent helper takes the status as its FIRST argument,
 * because Cloudflare reports failures with a 4xx and the status is the
 * interesting variable. Purelymail does not: an authentication failure arrives
 * as **HTTP 200** carrying `{"type":"error","code":"invalidToken"}`, which is
 * live-verified (see `src/errors.ts`). The status is therefore the boring
 * variable here and it is last, with a default of 200 — so a test that does not
 * mention a status reproduces the shape the real API actually sends, rather
 * than a shape that only exists in the published OpenAPI document.
 *
 * Nothing in this file is a real credential. `TEST_TOKEN` is a marked literal
 * chosen so a containment assertion over serialized output cannot match by
 * accident.
 */
import type { PurelymailAdapterError, PurelymailFetch } from "../src/index.ts";

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased, so a test never depends on the sent casing. */
  headers: Record<string, string>;
  body: string | null;
}

export interface StubResponse {
  status?: number;
  /** Parsed JSON body. Wrap it with {@link ok} / {@link fail} if you want. */
  body?: unknown;
  /** Raw text body; when set, `body` is ignored. */
  text?: string;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export interface FetchStub {
  impl: PurelymailFetch;
  calls: RecordedCall[];
  /** Always empty for this provider — asserted, not assumed. */
  queryOf(index: number): Record<string, string[]>;
  pathOf(index: number): string;
  bodyOf(index: number): Record<string, unknown>;
  /** The body exactly as serialized, for the `{}`-not-empty assertion. */
  rawBodyOf(index: number): string | null;
}

/**
 * The success envelope. Live-verified discriminator, not in the published
 * OpenAPI document — see `src/errors.ts` for the two sources it came from.
 */
export function ok(result: unknown): StubResponse {
  return { status: 200, body: { type: "success", result } };
}

/**
 * The envelope shape the OpenAPI document describes: a `result` with no `type`
 * discriminator at all. The adapter must read this as a success so that a
 * future removal of the discriminator degrades to the documented contract
 * instead of failing every call.
 */
export function documentedOk(result: unknown): StubResponse {
  return { status: 200, body: { result } };
}

/**
 * A failure envelope. **HTTP 200 by default**, because that is what the live
 * API sends; pass a status only when the test is about the status.
 */
export function fail(
  code: string,
  message: string,
  status = 200,
): StubResponse {
  return { status, body: { type: "error", code, message } };
}

/**
 * What an unknown operation name really returns: HTTP 404 carrying an HTML
 * page rather than an envelope. Live-verified, and exactly how a typo in
 * `PURELYMAIL_OPERATIONS` would present.
 */
export function htmlNotFound(): StubResponse {
  return {
    status: 404,
    text: "<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>",
    contentType: "text/html; charset=UTF-8",
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
 * requested URL so a test can answer dynamically. Running out of scripted
 * responses is a test bug and throws.
 */
export function createFetchStub(
  responses:
    | StubResponse[]
    | ((index: number, url: URL) => StubResponse | Promise<StubResponse>),
): FetchStub {
  const calls: RecordedCall[] = [];

  const impl: PurelymailFetch = async (url, init) => {
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

  const callAt = (index: number): RecordedCall => {
    const call = calls[index];
    if (call === undefined) throw new Error(`no call at index ${index}`);
    return call;
  };

  return {
    impl,
    calls,
    queryOf(index) {
      const out: Record<string, string[]> = {};
      new URL(callAt(index).url).searchParams.forEach((value, key) => {
        (out[key] ??= []).push(value);
      });
      return out;
    },
    pathOf(index) {
      return new URL(callAt(index).url).pathname;
    },
    bodyOf(index) {
      const body = callAt(index).body;
      if (body === null) throw new Error(`call ${index} had no body`);
      return JSON.parse(body) as Record<string, unknown>;
    },
    rawBodyOf(index) {
      return callAt(index).body;
    },
  };
}

/** A rejecting stub, for the transport-failure taxonomy tests. */
export function createFailingFetchStub(error: unknown): FetchStub {
  const calls: RecordedCall[] = [];
  const impl: PurelymailFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: {},
      body: typeof init.body === "string" ? init.body : null,
    });
    throw error;
  };
  const callAt = (index: number): RecordedCall => {
    const call = calls[index];
    if (call === undefined) throw new Error(`no call at index ${index}`);
    return call;
  };
  return {
    impl,
    calls,
    queryOf() {
      throw new Error("not applicable");
    },
    pathOf(index) {
      return new URL(callAt(index).url).pathname;
    },
    bodyOf(index) {
      const body = callAt(index).body;
      if (body === null) throw new Error(`call ${index} had no body`);
      return JSON.parse(body) as Record<string, unknown>;
    },
    rawBodyOf(index) {
      return callAt(index).body;
    },
  };
}

/**
 * Await a promise that must reject with a {@link PurelymailAdapterError}, and
 * return it narrowed. `.catch(e => e)` would union the error with the success
 * type, which makes every subsequent assertion a cast.
 */
export async function rejection(
  promise: Promise<unknown>,
): Promise<PurelymailAdapterError> {
  try {
    await promise;
  } catch (error) {
    return error as PurelymailAdapterError;
  }
  throw new Error("expected the call to reject, but it resolved");
}

/* ------------------------------------------------- obviously fake constants */

/** Not a credential. Marked so a containment check cannot match by accident. */
export const TEST_TOKEN = "pm_unit_test_api_token_NOT_A_REAL_TOKEN_000000";
export const TEST_DOMAIN = "example.test";
/** The provider's own base URL; no request in this suite ever leaves it. */
export const TEST_BASE_URL = "https://purelymail.com";
/** A per-ACCOUNT ownership code, as an opaque provider string. */
export const TEST_OWNERSHIP_CODE = "purelymail-unit-test-ownership-code-0000";

/** A provider-shaped domain object, as `listDomains` returns one. */
export function domainPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: TEST_DOMAIN,
    allowAccountReset: false,
    symbolicSubaddressing: false,
    isShared: false,
    dnsSummary: {
      passesMx: true,
      passesSpf: true,
      passesDkim: true,
      passesDmarc: true,
    },
    ...overrides,
  };
}

/** A provider-shaped routing rule, as `listRoutingRules` returns one. */
export function routingRulePayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 4_815_162_342,
    domainName: TEST_DOMAIN,
    prefix: false,
    matchUser: "abuse",
    targetAddresses: [`ops@${TEST_DOMAIN}`],
    catchall: false,
    ...overrides,
  };
}
