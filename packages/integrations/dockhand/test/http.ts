/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 *
 * Every unit test injects one of these through
 * `createDockhandAdapter({ fetchImpl })` so the suite exercises the real
 * request/response path — the session cookie, the `env` query parameter, both
 * documented list envelopes, fact mapping, error normalization — without a live
 * Dockhand instance, and without ever making a request.
 *
 * Nothing in this file is a real credential. The marker literals are chosen so
 * a containment assertion over serialized output cannot match by accident, and
 * {@link TEST_TLS_KEY} deliberately looks like the PEM body upstream documents
 * so the redaction assertions test the real hazard.
 */
import type { DockhandFetch } from "../src/index.ts";

export const TEST_PASSWORD = "zzz-dockhand-password-marker-zzz";
export const TEST_SESSION = "zzz-dockhand-session-marker-zzz";
export const TEST_USERNAME = "loxep-fleet-reader";
export const TEST_BASE_URL = "https://dockhand.example.invalid";
export const TEST_HAWSER_TOKEN = "zzz-hawser-token-marker-zzz";
/** Shaped like the "multi-line PEM string with BEGIN/END markers" upstream documents. */
export const TEST_TLS_KEY =
  "-----BEGIN PRIVATE KEY-----\nzzz-private-key-marker-zzz\n-----END PRIVATE KEY-----";

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased, so a test never depends on the sent casing. */
  headers: Record<string, string>;
  body: string | null;
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  text?: string;
  /** Extra response headers, e.g. `set-cookie` on the login route. */
  headers?: Record<string, string>;
}

export interface FetchStub {
  impl: DockhandFetch;
  calls: RecordedCall[];
  pathOf(index: number): string;
  queryOf(index: number): Record<string, string>;
  bodyOf(index: number): Record<string, unknown>;
}

/** The login response: 200 plus the session cookie upstream sets. */
export function loginOk(session: string = TEST_SESSION): StubResponse {
  return {
    status: 200,
    body: { success: true },
    headers: {
      "set-cookie": `dockhand_session=${session}; Path=/; HttpOnly; SameSite=Lax`,
    },
  };
}

/** The documented error envelope: `{error, details}`. */
export function fail(
  status: number,
  error: string,
  details?: string,
): StubResponse {
  return {
    status,
    body: details === undefined ? { error } : { error, details },
  };
}

/** A bare array — the shape the API overview documents for list endpoints. */
export function bareList(items: unknown[]): StubResponse {
  return { status: 200, body: items };
}

/** A wrapped array — the shape the containers endpoint page documents. */
export function wrappedList(key: string, items: unknown[]): StubResponse {
  return { status: 200, body: { [key]: items } };
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: DockhandFetch = async (url, init) => {
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
    const responseHeaders = new Headers({ "content-type": "application/json" });
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      responseHeaders.append(key, value);
    }
    return new Response(text, {
      status: response.status ?? 200,
      headers: responseHeaders,
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
  };
}

/** An environment record, with every documented field populated. */
export function environmentRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 1,
    name: "vps-fra-01",
    connectionType: "direct",
    host: "10.0.0.5",
    port: 2376,
    protocol: "https",
    socketPath: "/var/run/docker.sock",
    tlsCa: "-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----",
    tlsCert: "-----BEGIN CERTIFICATE-----\ncert\n-----END CERTIFICATE-----",
    tlsKey: TEST_TLS_KEY,
    tlsSkipVerify: false,
    hawserToken: TEST_HAWSER_TOKEN,
    hawserLastSeen: "2026-08-13T07:00:00.000Z",
    hawserAgentId: "agent-1",
    labels: ["prod", "eu"],
    publicIp: "203.0.113.9",
    icon: "globe",
    collectActivity: true,
    collectMetrics: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-08-13T07:00:00.000Z",
    ...overrides,
  };
}

export function containerRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "c0ffee0000",
    name: "loxep-web",
    image: "ghcr.io/loxep/loxep:1.2.3",
    state: "running",
    status: "Up 3 days",
    ...overrides,
  };
}

export function stackRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "loxep",
    status: "running",
    sourceType: "git",
    containers: ["c0ffee0000", "c0ffee0001"],
    containerDetails: [
      { id: "c0ffee0000", name: "loxep-web", state: "running" },
      { id: "c0ffee0001", name: "loxep-db", state: "exited" },
    ],
    ...overrides,
  };
}
