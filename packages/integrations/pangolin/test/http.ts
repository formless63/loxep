/**
 * Deterministic `fetch` stub for the unit tests. No network, no timers.
 * Response bodies default to Pangolin's real `{data, success, error,
 * message, status}` envelope, source- and live-verified in `errors.ts`.
 */
import type { PangolinFetch } from "../src/index.ts";

/** Distinctive markers: a containment assertion on these cannot false-positive. */
export const TEST_API_KEY_ID = "test-pangolin-key-id-marker-zzz";
export const TEST_API_KEY_SECRET = "test-pangolin-key-secret-marker-zzz";
export const TEST_BASE_URL = "https://pangolin.example.invalid";
export const TEST_ORG_ID = "example-org";

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
  impl: PangolinFetch;
  calls: RecordedCall[];
  pathOf(index: number): string;
}

export function envelope(data: unknown, overrides: Partial<Record<string, unknown>> = {}): StubResponse {
  return {
    status: 200,
    body: { data, success: true, error: false, message: "", status: 200, ...overrides },
  };
}

export function failEnvelope(status: number, message: string): StubResponse {
  return {
    status,
    body: { data: null, success: false, error: true, message, status, stack: null },
  };
}

export function createFetchStub(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  let index = 0;

  const impl: PangolinFetch = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
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
    const text = response.text ?? (response.body === undefined ? "" : JSON.stringify(response.body));
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
  };
}

export function orgRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { orgId: TEST_ORG_ID, name: "Home Lab", ...overrides };
}

export function siteRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    siteId: 1,
    niceId: "site-1",
    orgId: TEST_ORG_ID,
    name: "home-newt",
    type: "newt",
    online: true,
    address: "10.10.0.2",
    subnet: "10.10.0.0/24",
    endpoint: null,
    listenPort: 51820,
    status: "approved",
    pubKey: "do-not-copy-pubkey",
    publicKey: "do-not-copy-publickey",
    ...overrides,
  };
}

export function resourceRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resourceId: 10,
    niceId: "resource-10",
    orgId: TEST_ORG_ID,
    name: "dockhand",
    subdomain: "dockhand",
    fullDomain: "dockhand.example.com",
    domainId: "example.com",
    mode: "http",
    ssl: true,
    enabled: true,
    blockAccess: false,
    sso: true,
    emailWhitelistEnabled: false,
    applyRules: true,
    health: "unknown",
    ...overrides,
  };
}

export function targetRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    targetId: 20,
    resourceId: 10,
    siteId: 1,
    ip: "192.168.1.10",
    port: 3000,
    method: "http",
    mode: "http",
    enabled: true,
    path: null,
    pathMatchType: null,
    priority: 100,
    authToken: "do-not-copy-authtoken",
    ...overrides,
  };
}

export function ruleRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 30,
    resourceId: 10,
    action: "ACCEPT",
    match: "CIDR",
    value: "203.0.113.7/32",
    priority: 1,
    enabled: true,
    ...overrides,
  };
}

export function domainRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domainId: "example.com",
    orgId: TEST_ORG_ID,
    baseDomain: "example.com",
    type: "wildcard",
    verified: true,
    failed: false,
    tries: 0,
    configManaged: false,
    certResolver: "letsencrypt",
    preferWildcardCert: true,
    ...overrides,
  };
}

export function dnsRecordRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 40,
    domainId: "example.com",
    recordType: "A",
    baseDomain: "example.com",
    value: "203.0.113.1",
    verified: true,
    ...overrides,
  };
}
