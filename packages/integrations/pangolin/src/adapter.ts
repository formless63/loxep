/**
 * The Pangolin READ adapter — milestone 1 of `loxep-acj`
 * (`apps/docs/.../architecture/pangolin-chain-design.md`). ADR-0009: no
 * Pangolin response type is exported from this package. Everything crossing
 * this boundary is a Loxep-owned fact.
 *
 * **This milestone issues NO write verb anywhere, structurally.** There is
 * no operation union to widen and no configuration flag that unlocks a
 * write — the exported surface has no member named after a write verb, and
 * `operations.ts`'s `PANGOLIN_ALLOWED_NON_GET_PATHS` is empty.
 * `test/boundary.test.ts` asserts every request this adapter makes is a
 * `GET`.
 *
 * ## Auth
 *
 * `Authorization: Bearer <apiKeyId>.<apiKeySecret>` — verified against
 * `fosrl/pangolin@main`'s `server/middlewares/integration/verifyApiKey.ts`
 * (splits the header on `"Bearer "`, then the token on `.`, looks up
 * `apiKeyId`, verifies the secret against a stored hash). **Not**
 * `X-API-Key` — the design document records a live probe showing that
 * header is silently ignored ("API key required").
 *
 * ## THE RECHABILITY FINDING — read this before wiring a connection
 *
 * The Integration API is a genuinely SEPARATE Express server
 * (`server/integrationApiServer.ts`), on its own port
 * (`config.server.integration_port`, conventionally `3003`), mounted at
 * `/v1`. It is not the same process, port, or router as the dashboard
 * — confirmed from source, not merely documentation.
 *
 * **Live reconnaissance against the owner's instance, 2026-08-15, found
 * this port is not reachable from this build environment on any path
 * tried**, despite exhausting every reasonable network route available:
 *
 * - the public base URL over HTTPS on 443, `/v1/openapi.json` (the
 *   documented-unauthenticated route): the dashboard's own Next.js app
 *   answers its own 404 page — no router forwards this path to the
 *   Integration API;
 * - `https://<host>:3003` directly, over both the public internet and a
 *   confirmed direct Tailscale connection to the actual Pangolin VPS
 *   (identified by matching its TLS certificate CN): connection refused —
 *   nothing is bound to that port on any reachable interface, consistent
 *   with a typical Traefik+Docker deployment where the container's port is
 *   never published to the host and only Traefik's own internal service
 *   discovery can reach it;
 * - five plausible dedicated-subdomain guesses
 *   (`api.<domain>`, `pangolin-api.<domain>`, etc. — the pattern Pangolin's
 *   own self-host documentation recommends): each resolves via wildcard DNS
 *   but answers Traefik's default self-signed certificate, meaning none has
 *   a router configured.
 *
 * **One genuine live confirmation did land**: the dashboard's own internal
 * `/api/v1/*` route (a DIFFERENT, session-cookie-gated API sharing the same
 * response-wrapper code) answered `HTTP 401` with
 * `{"data":null,"success":false,"error":true,"message":"Unauthorized","stack":null}` —
 * live proof of the exact envelope shape the design document predicted from
 * source, even though it did not exercise the bearer-authenticated surface
 * this adapter targets.
 *
 * **Consequence for this milestone and the connecting guide**: an operator
 * who pastes the Pangolin dashboard URL into this connection's base-URL
 * field will save successfully and then fail on first use — this is
 * exactly the "documented first-attempt trap" the design document warned
 * the guided form to call out. The base URL this adapter needs is the
 * Integration API's OWN origin, which requires a dedicated reverse-proxy
 * route the operator configures in front of the Pangolin container's
 * `integration_port` (a subdomain, per Pangolin's own self-host
 * documentation) — it is not derivable from the dashboard URL by any
 * fixed transformation, and `live-pangolin.test.ts` records the concrete
 * failure this produces against the owner's current instance today.
 *
 * ## The envelope
 *
 * `{data, success, error, message, status}` on every response —
 * source-verified (every router this adapter reads registers this exact
 * OpenAPI response schema) and live-confirmed via the dashboard's sibling
 * route above. `error` is a **boolean flag**, never a code string — see
 * `errors.ts` for the full classification and the HTTP-200-is-not-success
 * warning this shares with `@loxep/integration-purelymail`.
 *
 * ## Verb convention (irrelevant to M1, documented per the design's request)
 *
 * `PUT` creates, `POST` updates — the inversion of the usual REST
 * convention. M1 issues neither.
 */
import { z } from "zod";
import {
  PANGOLIN_ALLOWED_NON_GET_PATHS,
  PANGOLIN_ALLOWED_PATH_PREFIXES,
  pangolinDomainDnsRecordsPath,
  pangolinDomainsPath,
  pangolinOrgSitePath,
  pangolinOrgsPath,
  pangolinResourcePath,
  pangolinResourcesPath,
  pangolinRulesPath,
  pangolinSitePath,
  pangolinSitesPath,
  pangolinTargetsPath,
} from "./operations.ts";
import {
  PangolinAdapterError,
  normalizePangolinError,
  pangolinErrorFromResponse,
  readPangolinEnvelope,
  type PangolinErrorContext,
} from "./errors.ts";
import {
  type PangolinAdapterConfig,
  type PangolinAdapterConfigInput,
  parsePangolinAdapterConfig,
} from "./config.ts";
import {
  PANGOLIN_SUGGESTED_CAPACITY,
  PANGOLIN_SUGGESTED_REFILL_PER_SECOND,
  type PangolinAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
  createRateBudget,
} from "./rate-budget.ts";

/** The injected `fetch`. Every test passes a stub; nothing here calls global. */
export type PangolinFetch = (input: string, init: RequestInit) => Promise<Response>;

/** The bearer credential this adapter signs every request with. Secret material — never logged. */
export interface PangolinAdapterCredentials {
  apiKeyId: string;
  apiKeySecret: string;
}

/* --------------------------------------------------------- Loxep-owned facts */

export interface PangolinOrgFact {
  orgId: string;
  name: string | null;
}

/**
 * A Pangolin site. `endpoint` carries [open question 5](../../architecture/pangolin-chain-design/#open-questions)'s
 * answer — whether a site read exposes the address Pangolin currently
 * observes for an established newt tunnel, the best available dynamic-IP
 * alias source if it does. **UNVERIFIED against a live read** (see the
 * reachability finding above); `pubKey`/`publicKey` are deliberately NOT
 * carried — no secret material crosses this boundary.
 */
export interface PangolinSiteFact {
  siteId: number | null;
  niceId: string | null;
  orgId: string | null;
  name: string | null;
  /**
   * Source schema comment documents only `"newt"`/`"wireguard"`; the design
   * document additionally claims `'local'`. Left as a plain string rather
   * than a union until a live read confirms which values actually occur.
   */
  type: string | null;
  online: boolean;
  address: string | null;
  subnet: string | null;
  endpoint: string | null;
  listenPort: number | null;
  status: string | null;
}

export interface PangolinResourceFact {
  resourceId: number | null;
  niceId: string | null;
  orgId: string | null;
  name: string | null;
  subdomain: string | null;
  fullDomain: string | null;
  domainId: string | null;
  /** `mode` supersedes the deprecated `http`/`protocol` fields, which this fact never carries. */
  mode: string | null;
  ssl: boolean;
  enabled: boolean;
  blockAccess: boolean;
  /** Presence only — never a whitelist's contents. */
  sso: boolean | null;
  /** Presence only — never a whitelist's contents. */
  emailWhitelistEnabled: boolean | null;
  applyRules: boolean | null;
  health: string | null;
}

export interface PangolinTargetFact {
  targetId: number | null;
  resourceId: number | null;
  siteId: number | null;
  ip: string | null;
  port: number | null;
  method: string | null;
  mode: string | null;
  enabled: boolean;
  path: string | null;
  pathMatchType: string | null;
  priority: number | null;
}

/** Rule vocabulary exactly as the API has it (the UI labels differ). */
export interface PangolinRuleFact {
  ruleId: number | null;
  resourceId: number | null;
  action: string | null;
  match: string | null;
  value: string | null;
  priority: number | null;
  enabled: boolean;
}

export interface PangolinDomainFact {
  domainId: string | null;
  orgId: string | null;
  baseDomain: string | null;
  type: string | null;
  verified: boolean;
  failed: boolean;
  tries: number | null;
  configManaged: boolean;
  certResolver: string | null;
  preferWildcardCert: boolean | null;
}

export interface PangolinDomainDnsRecordFact {
  id: number | null;
  domainId: string | null;
  recordType: string | null;
  baseDomain: string | null;
  value: string | null;
  verified: boolean;
}

/**
 * What THIS instance can do, so the UI degrades honestly rather than
 * offering a control that silently does nothing (Phase 7's reason for
 * `capabilities()` on every port). Values below are the STATIC, source-derived
 * defaults for a self-hosted build; none has been confirmed against a live
 * read (see the reachability finding) and `capabilities()` does not attempt
 * one — this milestone reports what source promises, not what it proved.
 */
export interface PangolinCapabilities {
  provider: "pangolin";
  readOnly: true;
  /** Resource-policy bulk rule endpoint — Cloud/Enterprise-licence-gated, per the design document's citation. `false` for a self-hosted build. */
  bulkRuleSet: boolean;
  /** Constant `false` — no provider alias/IP-group primitive exists (design document's resolved open question 4). */
  ruleAliases: false;
  /** The `enabled` flag on rule update — a real schema column, source-verified. */
  ruleDisable: boolean;
  /** Undocumented, unspecced, build-dependent (`PUT /org/{orgId}/domain` carries no OpenAPI registration). Defaults `false`. */
  domainCreate: boolean;
  /** Reported per Phase 7's convention; Loxep never calls it regardless (ADR-0022). */
  siteCreate: boolean;
  ruleMatches: readonly string[];
  ruleActions: readonly string[];
}

export interface PangolinProbeFact {
  /** `false` only for a network-level failure; an auth rejection still reached the API. */
  reachable: boolean;
  /** Whether the stored credential was accepted. */
  authenticated: boolean;
  /** `null` when `authenticated` is `false`, or when no `orgId` is configured and the key is not root-scoped. */
  siteCount: number | null;
}

export interface PangolinAdapterStats {
  rateBudget: RateBudgetStats;
}

export interface PangolinAdapter {
  probe(): Promise<PangolinProbeFact>;
  listOrgs(): Promise<PangolinOrgFact[]>;
  listSites(orgId: string): Promise<PangolinSiteFact[]>;
  /** Prefers the numeric site id (no `orgId` needed); falls back to `orgId` + `niceId` for a non-numeric identifier. */
  getSite(siteIdOrNiceId: string, orgId?: string): Promise<PangolinSiteFact | null>;
  listResources(orgId: string): Promise<PangolinResourceFact[]>;
  getResource(resourceId: string): Promise<PangolinResourceFact | null>;
  listTargets(resourceId: string): Promise<PangolinTargetFact[]>;
  listRules(resourceId: string): Promise<PangolinRuleFact[]>;
  listDomains(orgId: string): Promise<PangolinDomainFact[]>;
  /** A client-side filter over `listDomains` — no dedicated "find by name" endpoint exists in source. */
  findDomainByBaseName(orgId: string, baseDomain: string): Promise<PangolinDomainFact | null>;
  listDomainDnsRecords(orgId: string, domainId: string): Promise<PangolinDomainDnsRecordFact[]>;
  capabilities(): PangolinCapabilities;
  stats(): PangolinAdapterStats;
}

export interface CreatePangolinAdapterInput {
  config: PangolinAdapterConfigInput;
  credentials: PangolinAdapterCredentials;
  fetchImpl: PangolinFetch;
  logger?: PangolinAdapterLogger;
  rateBudget?: RateBudget;
}

/* ------------------------------------------------------------- boundary parsing */
// Every schema below is deliberately permissive: the design document's own
// stability warning applies — "structure the adapter... so correcting a
// wrong name is a one-line change" — and the same restraint extends to
// fields. Nothing here is treated as UNVERIFIED-and-therefore-omitted; it is
// UNVERIFIED-and-therefore-optional, so a future live read that finds a
// field absent degrades to `null` instead of failing the whole record.

const orgSchema = z.object({
  orgId: z.string(),
  name: z.string().optional(),
});

const siteSchema = z.object({
  siteId: z.union([z.number(), z.string()]).optional(),
  niceId: z.string().optional(),
  orgId: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  online: z.boolean().optional(),
  address: z.string().nullable().optional(),
  subnet: z.string().nullable().optional(),
  endpoint: z.string().nullable().optional(),
  listenPort: z.number().nullable().optional(),
  status: z.string().nullable().optional(),
});

const resourceSchema = z.object({
  resourceId: z.union([z.number(), z.string()]).optional(),
  niceId: z.string().optional(),
  orgId: z.string().optional(),
  name: z.string().optional(),
  subdomain: z.string().nullable().optional(),
  fullDomain: z.string().nullable().optional(),
  domainId: z.string().nullable().optional(),
  mode: z.string().optional(),
  ssl: z.boolean().optional(),
  enabled: z.boolean().optional(),
  blockAccess: z.boolean().optional(),
  sso: z.boolean().nullable().optional(),
  emailWhitelistEnabled: z.boolean().nullable().optional(),
  applyRules: z.boolean().nullable().optional(),
  health: z.string().nullable().optional(),
});

const targetSchema = z.object({
  targetId: z.union([z.number(), z.string()]).optional(),
  resourceId: z.union([z.number(), z.string()]).nullable().optional(),
  siteId: z.union([z.number(), z.string()]).nullable().optional(),
  ip: z.string().optional(),
  port: z.number().optional(),
  method: z.string().nullable().optional(),
  mode: z.string().optional(),
  enabled: z.boolean().optional(),
  path: z.string().nullable().optional(),
  pathMatchType: z.string().nullable().optional(),
  priority: z.number().optional(),
});

const ruleSchema = z.object({
  ruleId: z.union([z.number(), z.string()]).optional(),
  resourceId: z.union([z.number(), z.string()]).nullable().optional(),
  action: z.string().optional(),
  match: z.string().optional(),
  value: z.string().optional(),
  priority: z.number().optional(),
  enabled: z.boolean().optional(),
});

const domainSchema = z.object({
  domainId: z.string().optional(),
  orgId: z.string().optional(),
  baseDomain: z.string().optional(),
  type: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  failed: z.boolean().optional(),
  tries: z.number().nullable().optional(),
  configManaged: z.boolean().optional(),
  certResolver: z.string().nullable().optional(),
  preferWildcardCert: z.boolean().nullable().optional(),
});

const dnsRecordSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  domainId: z.string().optional(),
  recordType: z.string().optional(),
  baseDomain: z.string().nullable().optional(),
  value: z.string().optional(),
  verified: z.boolean().optional(),
});

function toNumberOrNull(value: number | string | undefined): number | null {
  if (value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toOrgFact(raw: unknown): PangolinOrgFact | null {
  const parsed = orgSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { orgId: parsed.data.orgId, name: parsed.data.name ?? null };
}

function toSiteFact(raw: unknown): PangolinSiteFact | null {
  const parsed = siteSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    siteId: toNumberOrNull(v.siteId),
    niceId: v.niceId ?? null,
    orgId: v.orgId ?? null,
    name: v.name ?? null,
    type: v.type ?? null,
    online: v.online ?? false,
    address: v.address ?? null,
    subnet: v.subnet ?? null,
    endpoint: v.endpoint ?? null,
    listenPort: v.listenPort ?? null,
    status: v.status ?? null,
  };
}

function toResourceFact(raw: unknown): PangolinResourceFact | null {
  const parsed = resourceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    resourceId: toNumberOrNull(v.resourceId),
    niceId: v.niceId ?? null,
    orgId: v.orgId ?? null,
    name: v.name ?? null,
    subdomain: v.subdomain ?? null,
    fullDomain: v.fullDomain ?? null,
    domainId: v.domainId ?? null,
    mode: v.mode ?? null,
    ssl: v.ssl ?? false,
    enabled: v.enabled ?? false,
    blockAccess: v.blockAccess ?? false,
    sso: v.sso ?? null,
    emailWhitelistEnabled: v.emailWhitelistEnabled ?? null,
    applyRules: v.applyRules ?? null,
    health: v.health ?? null,
  };
}

function toTargetFact(raw: unknown): PangolinTargetFact | null {
  const parsed = targetSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    targetId: toNumberOrNull(v.targetId),
    resourceId: toNumberOrNull(v.resourceId ?? undefined),
    siteId: toNumberOrNull(v.siteId ?? undefined),
    ip: v.ip ?? null,
    port: v.port ?? null,
    method: v.method ?? null,
    mode: v.mode ?? null,
    enabled: v.enabled ?? false,
    path: v.path ?? null,
    pathMatchType: v.pathMatchType ?? null,
    priority: v.priority ?? null,
  };
}

function toRuleFact(raw: unknown): PangolinRuleFact | null {
  const parsed = ruleSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    ruleId: toNumberOrNull(v.ruleId),
    resourceId: toNumberOrNull(v.resourceId ?? undefined),
    action: v.action ?? null,
    match: v.match ?? null,
    value: v.value ?? null,
    priority: v.priority ?? null,
    enabled: v.enabled ?? false,
  };
}

function toDomainFact(raw: unknown): PangolinDomainFact | null {
  const parsed = domainSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    domainId: v.domainId ?? null,
    orgId: v.orgId ?? null,
    baseDomain: v.baseDomain ?? null,
    type: v.type ?? null,
    verified: v.verified ?? false,
    failed: v.failed ?? false,
    tries: v.tries ?? null,
    configManaged: v.configManaged ?? false,
    certResolver: v.certResolver ?? null,
    preferWildcardCert: v.preferWildcardCert ?? null,
  };
}

function toDnsRecordFact(raw: unknown): PangolinDomainDnsRecordFact | null {
  const parsed = dnsRecordSchema.safeParse(raw);
  if (!parsed.success) return null;
  const v = parsed.data;
  return {
    id: toNumberOrNull(v.id),
    domainId: v.domainId ?? null,
    recordType: v.recordType ?? null,
    baseDomain: v.baseDomain ?? null,
    value: v.value ?? null,
    verified: v.verified ?? false,
  };
}

/** Every list endpoint but DNS records nests its array under a named key plus `pagination`. */
function unwrapListField(data: unknown, key: string, context: PangolinErrorContext): unknown[] {
  const record =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const items = record?.[key];
  if (!Array.isArray(items)) {
    throw new PangolinAdapterError(
      "invalid_request",
      `Pangolin ${key} list response was not shaped as expected`,
      { operation: context.operation, path: context.path },
    );
  }
  return items;
}

/** `GET .../dns-records` answers a bare array — the one list exception. */
function unwrapArray(data: unknown, context: PangolinErrorContext): unknown[] {
  if (!Array.isArray(data)) {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin DNS records response was not an array",
      { operation: context.operation, path: context.path },
    );
  }
  return data;
}

export function createPangolinAdapter(input: CreatePangolinAdapterInput): PangolinAdapter {
  const config: PangolinAdapterConfig = parsePangolinAdapterConfig(input.config);
  const { fetchImpl, logger, credentials } = input;

  if (credentials.apiKeyId === "" || credentials.apiKeySecret === "") {
    throw new PangolinAdapterError(
      "invalid_request",
      "Pangolin API key id and secret must both be non-empty",
    );
  }

  const rateBudget =
    input.rateBudget ??
    createRateBudget({
      capacity: PANGOLIN_SUGGESTED_CAPACITY,
      refillPerSecond: PANGOLIN_SUGGESTED_REFILL_PER_SECOND,
      ...(logger === undefined ? {} : { logger }),
    });

  const authorization = `Bearer ${credentials.apiKeyId}.${credentials.apiKeySecret}`;

  const request = async (path: string, operation: string): Promise<unknown> => {
    const context: PangolinErrorContext = { operation, path };

    // Belt-and-suspenders, mirroring every sibling adapter: unreachable
    // through the exported surface (there is no member that could build an
    // undeclared path), but it exists so a future edit adding one fails
    // here rather than at the provider.
    const allowed = PANGOLIN_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!allowed && !PANGOLIN_ALLOWED_NON_GET_PATHS.includes(path)) {
      throw new PangolinAdapterError(
        "invalid_request",
        "Pangolin adapter refused a request to an undeclared path",
        { operation, path },
      );
    }

    await rateBudget.acquire(1);

    const url = `${config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json", authorization },
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw normalizePangolinError(error, context);
    }

    let parsed: unknown = null;
    let parseFailed = false;
    try {
      const text = await response.text();
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parseFailed = true;
    }

    const envelope = parseFailed
      ? { success: null, error: null, message: null, status: null, data: null }
      : readPangolinEnvelope(parsed);
    const envelopeFailed = envelope.success === false || envelope.error === true;

    // Checked on EVERY response, not just non-2xx ones — HTTP 200 does not
    // imply success (the design's binding warning, live-confirmed).
    if (!response.ok || parseFailed || envelopeFailed || envelope.success === null) {
      throw pangolinErrorFromResponse(response.status, envelope, context);
    }
    return envelope.data;
  };

  const listDomainsImpl = async (orgId: string): Promise<PangolinDomainFact[]> => {
    const path = pangolinDomainsPath(orgId);
    const data = await request(path, "domains.list");
    const items = unwrapListField(data, "domains", { operation: "domains.list", path });
    const facts: PangolinDomainFact[] = [];
    for (const item of items) {
      const fact = toDomainFact(item);
      if (fact === null) {
        logger?.warn?.({ operation: "domains.list" }, "Pangolin returned a domain Loxep could not read; skipping it");
        continue;
      }
      facts.push(fact);
    }
    return facts;
  };

  const readBack = async <T>(
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof PangolinAdapterError && error.kind === "not_found") {
        return null;
      }
      throw error;
    }
  };

  return {
    async probe() {
      try {
        if (config.orgId !== null) {
          const data = await request(pangolinSitesPath(config.orgId), "sites.list");
          const items = unwrapListField(data, "sites", { operation: "sites.list", path: pangolinSitesPath(config.orgId) });
          return { reachable: true, authenticated: true, siteCount: items.length };
        }
        const data = await request(pangolinOrgsPath(), "orgs.list");
        const items = unwrapListField(data, "orgs", { operation: "orgs.list", path: pangolinOrgsPath() });
        return { reachable: true, authenticated: true, siteCount: items.length };
      } catch (error) {
        if (error instanceof PangolinAdapterError && error.kind === "auth") {
          return { reachable: true, authenticated: false, siteCount: null };
        }
        throw error;
      }
    },

    async listOrgs() {
      const data = await request(pangolinOrgsPath(), "orgs.list");
      const items = unwrapListField(data, "orgs", { operation: "orgs.list", path: pangolinOrgsPath() });
      const facts: PangolinOrgFact[] = [];
      for (const item of items) {
        const fact = toOrgFact(item);
        if (fact === null) {
          logger?.warn?.({ operation: "orgs.list" }, "Pangolin returned an org Loxep could not read; skipping it");
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    async listSites(orgId: string) {
      const path = pangolinSitesPath(orgId);
      const data = await request(path, "sites.list");
      const items = unwrapListField(data, "sites", { operation: "sites.list", path });
      const facts: PangolinSiteFact[] = [];
      for (const item of items) {
        const fact = toSiteFact(item);
        if (fact === null) {
          logger?.warn?.({ operation: "sites.list" }, "Pangolin returned a site Loxep could not read; skipping it");
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    async getSite(siteIdOrNiceId: string, orgId?: string) {
      const isNumeric = /^[0-9]+$/.test(siteIdOrNiceId);
      if (isNumeric) {
        return readBack(async () => {
          const path = pangolinSitePath(siteIdOrNiceId);
          const data = await request(path, "site.get");
          const fact = toSiteFact(data);
          if (fact === null) {
            throw new PangolinAdapterError(
              "invalid_request",
              "Pangolin site response was not shaped as expected",
              { operation: "site.get", path },
            );
          }
          return fact;
        });
      }
      const effectiveOrgId = orgId ?? config.orgId;
      if (effectiveOrgId === null) {
        throw new PangolinAdapterError(
          "invalid_request",
          "getSite by niceId requires an orgId (none configured on this connection and none passed)",
        );
      }
      return readBack(async () => {
        const path = pangolinOrgSitePath(effectiveOrgId, siteIdOrNiceId);
        const data = await request(path, "site.get");
        const fact = toSiteFact(data);
        if (fact === null) {
          throw new PangolinAdapterError(
            "invalid_request",
            "Pangolin site response was not shaped as expected",
            { operation: "site.get", path },
          );
        }
        return fact;
      });
    },

    async listResources(orgId: string) {
      const path = pangolinResourcesPath(orgId);
      const data = await request(path, "resources.list");
      const items = unwrapListField(data, "resources", { operation: "resources.list", path });
      const facts: PangolinResourceFact[] = [];
      for (const item of items) {
        const fact = toResourceFact(item);
        if (fact === null) {
          logger?.warn?.({ operation: "resources.list" }, "Pangolin returned a resource Loxep could not read; skipping it");
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    async getResource(resourceId: string) {
      return readBack(async () => {
        const path = pangolinResourcePath(resourceId);
        const data = await request(path, "resource.get");
        const fact = toResourceFact(data);
        if (fact === null) {
          throw new PangolinAdapterError(
            "invalid_request",
            "Pangolin resource response was not shaped as expected",
            { operation: "resource.get", path },
          );
        }
        return fact;
      });
    },

    async listTargets(resourceId: string) {
      const path = pangolinTargetsPath(resourceId);
      const data = await request(path, "targets.list");
      const items = unwrapListField(data, "targets", { operation: "targets.list", path });
      const facts: PangolinTargetFact[] = [];
      for (const item of items) {
        const fact = toTargetFact(item);
        if (fact === null) {
          logger?.warn?.({ operation: "targets.list" }, "Pangolin returned a target Loxep could not read; skipping it");
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    async listRules(resourceId: string) {
      const path = pangolinRulesPath(resourceId);
      const data = await request(path, "rules.list");
      const items = unwrapListField(data, "rules", { operation: "rules.list", path });
      const facts: PangolinRuleFact[] = [];
      for (const item of items) {
        const fact = toRuleFact(item);
        if (fact === null) {
          logger?.warn?.({ operation: "rules.list" }, "Pangolin returned a rule Loxep could not read; skipping it");
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    async listDomains(orgId: string) {
      return listDomainsImpl(orgId);
    },

    async findDomainByBaseName(orgId: string, baseDomain: string) {
      const normalized = baseDomain.trim().toLowerCase();
      const domains = await listDomainsImpl(orgId);
      return domains.find((d) => d.baseDomain?.toLowerCase() === normalized) ?? null;
    },

    async listDomainDnsRecords(orgId: string, domainId: string) {
      const path = pangolinDomainDnsRecordsPath(orgId, domainId);
      const data = await request(path, "domain.dnsRecords");
      const items = unwrapArray(data, { operation: "domain.dnsRecords", path });
      const facts: PangolinDomainDnsRecordFact[] = [];
      for (const item of items) {
        const fact = toDnsRecordFact(item);
        if (fact === null) {
          logger?.warn?.({ operation: "domain.dnsRecords" }, "Pangolin returned a DNS record Loxep could not read; skipping it");
          continue;
        }
        facts.push(fact);
      }
      return facts;
    },

    capabilities() {
      return {
        provider: "pangolin",
        readOnly: true,
        bulkRuleSet: false,
        ruleAliases: false,
        ruleDisable: true,
        domainCreate: false,
        siteCreate: true,
        ruleMatches: ["CIDR", "IP", "PATH", "COUNTRY", "COUNTRY_IS_NOT", "ASN", "REGION"],
        ruleActions: ["ACCEPT", "DROP", "PASS"],
      };
    },

    stats() {
      return { rateBudget: rateBudget.stats() };
    },
  };
}
