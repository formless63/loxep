/**
 * Cloudflare adapter (loxep-lmy.1): a Loxep-owned boundary over the Cloudflare
 * REST API v4, implemented on **native `fetch`** with no client dependency
 * (ADR-0009).
 *
 * Why no library: the protocol work a client would save is (a) one bearer
 * header, (b) query-string building, (c) unwrapping a success/error envelope.
 * `cloudflare` (the official SDK) is a large generated surface whose types are
 * exactly the provider types ADR-0009 #5 says must not become canonical domain
 * types, and every one of them would have to be re-declared at this boundary
 * anyway.
 *
 * ## Verified upstream facts (developers.cloudflare.com + the official
 * `cloudflare/api-schemas` OpenAPI document, `info.version` 4.0.0; 2026-08-13)
 *
 * ```text
 * base                 https://api.cloudflare.com/client/v4
 * auth                 Authorization: Bearer <API_TOKEN>
 * list zones           GET  /zones                      ?name= &account.id= &page= &per_page=
 *                        per_page default 20, min 5, MAX 50
 * zone status enum     initializing | pending | active | moved
 * list records         GET  /zones/{zone_id}/dns_records  ?type= &name= &page= &per_page=
 *                        per_page default 100, min 1, documented max 5 000 000
 * create record        POST   /zones/{zone_id}/dns_records
 * overwrite record     PUT    /zones/{zone_id}/dns_records/{id}   ("Overwrite")
 * partial update       PATCH  /zones/{zone_id}/dns_records/{id}   ("Update")
 * delete record        DELETE /zones/{zone_id}/dns_records/{id}
 * envelope             {success, errors[], messages[], result, result_info?}
 * rate limit           1200 requests / 5 minutes PER USER, 429 + retry-after
 * ttl                  1 means "automatic"; otherwise 60..86400 (30 on Enterprise)
 * proxied              only A / AAAA / CNAME; each record carries `proxiable`
 * proxied wildcards    available on ALL plans (this changed; it was Enterprise-only)
 * Universal SSL        apex + ONE label of subdomain on a full setup
 * ```
 *
 * **This adapter uses PUT, not PATCH, for an update.** PUT is documented as
 * "Overwrite an existing DNS record"; PATCH is documented as "Update", but
 * Cloudflare never states that PATCH preserves omitted fields, so relying on
 * merge semantics would be relying on an inference. A desired-state reconciler
 * always knows the complete record it wants, so full replacement is both the
 * documented path and the correct one.
 *
 * ## Boundary rules enforced here
 *
 * - the API token goes into an `Authorization` header ONLY. Never a URL, query
 *   string, or body, so no error, log field, or thrown value reachable from
 *   this module can structurally contain it;
 * - every request acquires from the per-connection {@link RateBudget} BEFORE
 *   touching the network;
 * - **the envelope is checked on every response, not just non-2xx ones** — the
 *   design's explicit warning about RPC-shaped APIs;
 * - every failure is normalized to {@link CloudflareAdapterError} with
 *   credential-free `detail`;
 * - no provider response type is exported. Everything crossing this boundary
 *   is a Loxep-owned fact, so `@loxep/infrastructure` can re-declare the
 *   shapes structurally and take no dependency on this package — the
 *   discipline `@loxep/commerce` already applies to the eBay fact types.
 *
 * ## Names are translated at this boundary
 *
 * Cloudflare wants a *"complete DNS record name, including the zone name"*.
 * Loxep's `dns_records.name` is zone-relative (`@`, `*`, `key1._domainkey`)
 * because the natural key `(domain_id, type, name, content)` must be
 * recomputable on both sides of a diff without knowing a provider's naming
 * convention. {@link toProviderName} / {@link toLoxepName} are the only two
 * places that translation exists.
 */
import {
  CLOUDFLARE_PROXIABLE_TYPES,
  CLOUDFLARE_RECORDS_DEFAULT_PER_PAGE,
  CLOUDFLARE_RECORDS_MAX_PER_PAGE,
  CLOUDFLARE_ZONES_DEFAULT_PER_PAGE,
  CLOUDFLARE_MAX_TTL_SECONDS,
  CLOUDFLARE_MIN_TTL_SECONDS,
  cloudflareSourceAccountKey,
  cloudflareTtlFromLoxep,
  loxepTtlFromCloudflare,
  parseCloudflareAdapterConfig,
  type CloudflareAdapterConfig,
  type CloudflareAdapterConfigInput,
} from "./config.ts";
import {
  CLOUDFLARE_RECORD_EXISTS_CODES,
  CloudflareAdapterError,
  cloudflareErrorFromResponse,
  envelopeCodes,
  normalizeCloudflareError,
  readCloudflareEnvelope,
  type CloudflareEnvelope,
  type CloudflareErrorContext,
} from "./errors.ts";
import {
  createRateBudget,
  type CloudflareAdapterLogger,
  type RateBudget,
  type RateBudgetStats,
} from "./rate-budget.ts";

/* ------------------------------------------------------- Loxep-owned facts */

/** A DNS zone as Loxep understands it. No provider type is exported. */
export interface CloudflareZoneFact {
  externalZoneId: string;
  name: string;
  /**
   * The provider's own status string, VERBATIM. Retained rather than mapped,
   * because `managed_domains.provider_zone_status` is evidence and
   * `managed_domains.state` is Loxep's interpretation. Only `active` is
   * branched on anywhere.
   */
  status: string;
  /** Ordered, opaque, displayed for the operator to paste at the registrar. */
  nameservers: string[];
  accountId: string | null;
  paused: boolean;
}

/** One observed DNS record, in Loxep's vocabulary and with a Loxep TTL. */
export interface CloudflareDnsRecordFact {
  /** Captured opportunistically; never identity. */
  externalRecordId: string;
  type: string;
  /** ZONE-RELATIVE: `@`, `*`, `key1._domainkey`. */
  name: string;
  content: string;
  /** `null` means "provider default" — the sentinel never survives to here. */
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
  /** Cloudflare's read-only per-record signal; drives honest UI degradation. */
  proxiable: boolean;
}

/** The record shape an apply operation carries. Zone-relative name. */
export interface DnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
}

export type DnsApplyOperation =
  | { kind: "create"; record: DnsRecordInput }
  | { kind: "update"; externalRecordId: string; record: DnsRecordInput }
  | {
      kind: "delete";
      externalRecordId: string;
      record: Pick<DnsRecordInput, "type" | "name" | "content">;
    };

export interface DnsApplyResult {
  kind: DnsApplyOperation["kind"];
  type: string;
  name: string;
  /**
   * `applied`          the provider accepted the change
   * `already_present`  a create raced a create; the record exists
   * `already_absent`   a delete raced a delete; nothing to remove
   *
   * The last two exist because jobs are at-least-once: a retried apply must
   * converge, not fail.
   */
  status: "applied" | "already_present" | "already_absent";
  externalRecordId: string | null;
}

/**
 * What optional features this provider supports — the design's addition to the
 * specification's `read`/`apply` pair, and what lets the UI degrade honestly
 * rather than offering a control that silently does nothing.
 */
export interface DnsProviderCapabilities {
  provider: "cloudflare";
  /** The provider answers for the name and forwards to the origin. */
  proxying: boolean;
  proxiableTypes: readonly string[];
  /**
   * Verified 2026-08-13: *"Customers on all plans can create and proxy
   * wildcard DNS records."* This CHANGED — proxied wildcards were previously
   * Enterprise-only, which is why the design flagged it as a gate.
   */
  proxiedWildcards: boolean;
  wildcardRecords: boolean;
  /** `null` TTL is supported and means "let the provider choose". */
  automaticTtl: boolean;
  minTtlSeconds: number;
  maxTtlSeconds: number;
  /**
   * How many subdomain labels the provider's automatic certificate covers on
   * a full setup. Universal SSL covers *"your root domain and first-level
   * subdomains"* — so `a.b.example.com` is NOT covered without Total TLS or
   * an advanced certificate. Surfaced so a UI can warn before a nested name
   * is proxied.
   */
  automaticCertificateLabelDepth: number;
}

export interface CloudflareAdapterStats {
  baseUrl: string;
  sourceAccountKey: string;
  rateBudget: RateBudgetStats;
  /** Requests that reached the network (successful or not). */
  requests: number;
}

/* ------------------------------------------------------------ name mapping */

/** Zone-relative Loxep name -> the complete name Cloudflare requires. */
export function toProviderName(name: string, zoneName: string): string {
  const trimmed = name.trim().replace(/\.$/, "");
  if (trimmed === "" || trimmed === "@") return zoneName;
  if (trimmed === zoneName) return zoneName;
  if (trimmed.endsWith(`.${zoneName}`)) return trimmed;
  return `${trimmed}.${zoneName}`;
}

/** Complete provider name -> zone-relative Loxep name. */
export function toLoxepName(name: string, zoneName: string): string {
  const trimmed = name.trim().replace(/\.$/, "");
  if (trimmed === zoneName) return "@";
  if (trimmed.endsWith(`.${zoneName}`)) {
    return trimmed.slice(0, -(zoneName.length + 1));
  }
  return trimmed;
}

/* ------------------------------------------------------------ the adapter */

export type CloudflareFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export type CreateCloudflareAdapterInput = CloudflareAdapterConfigInput & {
  /**
   * Test seam only. Production code leaves this undefined and the adapter uses
   * the runtime's native `fetch`.
   */
  fetchImpl?: CloudflareFetch;
};

export interface CloudflareAdapter {
  readonly baseUrl: string;
  readonly sourceAccountKey: string;

  /** `GET /zones`, paginated. `name` narrows to one domain. */
  listZones(options?: {
    name?: string;
    accountId?: string;
    maxPages?: number;
  }): Promise<CloudflareZoneFact[]>;

  /** The one zone whose name matches exactly, or `null`. */
  findZoneByName(name: string): Promise<CloudflareZoneFact | null>;

  /** `GET /zones/{id}`. */
  getZone(externalZoneId: string): Promise<CloudflareZoneFact>;

  /**
   * The design's `read(subject)`: observed state in Loxep types. Walks every
   * page of the zone's records.
   */
  read(subject: {
    externalZoneId: string;
    zoneName: string;
    maxPages?: number;
  }): Promise<CloudflareDnsRecordFact[]>;

  /**
   * The design's `apply(diff)`. Operations are applied in order and each
   * result is reported individually; a failure throws, so the caller records
   * the steps it already collected and marks the run `partial`.
   */
  apply(input: {
    externalZoneId: string;
    zoneName: string;
    operations: readonly DnsApplyOperation[];
  }): Promise<DnsApplyResult[]>;

  capabilities(): DnsProviderCapabilities;
  stats(): CloudflareAdapterStats;
}

const DEFAULT_BUDGET = { capacity: 8, refillPerSecond: 1 } as const;
const DEFAULT_MAX_PAGES = 50;

type QueryValue = string | number | boolean | undefined;

function buildQuery(query: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.append(key, String(value));
  }
  const serialized = params.toString();
  return serialized === "" ? "" : `?${serialized}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(
  value: unknown,
  field: string,
  context: CloudflareErrorContext,
): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new CloudflareAdapterError(
    "provider_unavailable",
    `Cloudflare response is missing the required field "${field}"`,
    { operation: context.operation, path: context.path, field },
  );
}

/** Provider zone object -> Loxep fact. Nothing else reads the raw shape. */
function toZoneFact(
  raw: unknown,
  context: CloudflareErrorContext,
): CloudflareZoneFact {
  const record = asRecord(raw);
  if (record === null) {
    throw new CloudflareAdapterError(
      "provider_unavailable",
      "Cloudflare zone result was not an object",
      { operation: context.operation, path: context.path },
    );
  }
  const account = asRecord(record["account"]);
  const nameservers = record["name_servers"];
  const accountId = account?.["id"];
  return {
    externalZoneId: requiredString(record["id"], "id", context),
    name: requiredString(record["name"], "name", context),
    status: typeof record["status"] === "string" ? record["status"] : "unknown",
    nameservers: Array.isArray(nameservers)
      ? nameservers.filter((entry): entry is string => typeof entry === "string")
      : [],
    accountId: typeof accountId === "string" ? accountId : null,
    paused: record["paused"] === true,
  };
}

/** Provider record object -> Loxep fact, with the TTL sentinel translated. */
function toRecordFact(
  raw: unknown,
  zoneName: string,
  context: CloudflareErrorContext,
): CloudflareDnsRecordFact {
  const record = asRecord(raw);
  if (record === null) {
    throw new CloudflareAdapterError(
      "provider_unavailable",
      "Cloudflare DNS record result was not an object",
      { operation: context.operation, path: context.path },
    );
  }
  const priority = record["priority"];
  return {
    externalRecordId: requiredString(record["id"], "id", context),
    type: requiredString(record["type"], "type", context),
    name: toLoxepName(requiredString(record["name"], "name", context), zoneName),
    content: typeof record["content"] === "string" ? record["content"] : "",
    ttlSeconds: loxepTtlFromCloudflare(record["ttl"]),
    priority: typeof priority === "number" ? priority : null,
    proxied: record["proxied"] === true,
    proxiable: record["proxiable"] === true,
  };
}

export function createCloudflareAdapter(
  input: CreateCloudflareAdapterInput,
): CloudflareAdapter {
  const { logger, rateBudget, fetchImpl, ...rest } = input;
  const config: CloudflareAdapterConfig = parseCloudflareAdapterConfig(rest);
  const budget: RateBudget =
    rateBudget ?? createRateBudget({ ...DEFAULT_BUDGET, logger });
  const doFetch: CloudflareFetch =
    fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const sourceAccountKey = cloudflareSourceAccountKey(config.accountId ?? null);

  // Computed once and held in this closure. Never read back out, never logged,
  // never attached to an error or a stats object.
  const authorization = `Bearer ${config.apiToken}`;
  let requests = 0;

  /**
   * One request. Returns the parsed envelope for a successful call and throws
   * a taxonomy error otherwise — including for a 2xx whose envelope reports
   * `success: false`.
   */
  const request = async (
    method: string,
    path: string,
    options: {
      operation: string;
      query?: Record<string, QueryValue>;
      body?: unknown;
      /** DELETE may answer without the envelope; see the note below. */
      tolerateBareResult?: boolean;
    },
  ): Promise<CloudflareEnvelope> => {
    const context: CloudflareErrorContext = {
      operation: options.operation,
      path,
    };
    await budget.acquire(1);

    const url = `${config.baseUrl}${path}${buildQuery(options.query ?? {})}`;
    let response: Response;
    requests += 1;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          authorization,
          accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
    } catch (error) {
      throw normalizeCloudflareError(error, context);
    }

    let parsed: unknown = null;
    try {
      const text = await response.text();
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    const envelope = readCloudflareEnvelope(parsed);

    if (response.status === 429) {
      // Cloudflare's own limit, not the local budget's. `retry-after` is the
      // only header worth surfacing and it is a number of seconds.
      const retryAfter = response.headers.get("retry-after");
      throw new CloudflareAdapterError(
        "rate_limited",
        "Cloudflare rate limit exceeded (1200 requests per five minutes, per user)",
        {
          source: "provider",
          operation: options.operation,
          path,
          httpStatus: 429,
          ...(retryAfter === null ? {} : { retryAfterSeconds: retryAfter }),
        },
      );
    }

    if (!response.ok) {
      throw cloudflareErrorFromResponse(response.status, envelope, context);
    }

    // The design's warning made operational: a 2xx does not imply success on
    // an envelope-shaped API. `success: null` is tolerated ONLY where the
    // endpoint is documented to answer with a bare `{result: {...}}` (DELETE),
    // and only when a result is actually present.
    if (envelope.success === false) {
      throw cloudflareErrorFromResponse(response.status, envelope, context);
    }
    if (envelope.success === null) {
      const bareResult =
        options.tolerateBareResult === true && envelope.result !== null;
      if (!bareResult) {
        throw cloudflareErrorFromResponse(response.status, envelope, context);
      }
    }
    return envelope;
  };

  const paginate = async (
    path: string,
    options: {
      operation: string;
      query?: Record<string, QueryValue>;
      perPage: number;
      maxPages: number;
    },
  ): Promise<unknown[]> => {
    const collected: unknown[] = [];
    for (let page = 1; page <= options.maxPages; page += 1) {
      const envelope = await request("GET", path, {
        operation: options.operation,
        query: { ...options.query, page, per_page: options.perPage },
      });
      const result = envelope.result;
      if (!Array.isArray(result)) {
        throw new CloudflareAdapterError(
          "provider_unavailable",
          "Cloudflare collection result was not an array",
          { operation: options.operation, path },
        );
      }
      collected.push(...result);
      const info = envelope.resultInfo;
      const totalPages = info?.totalPages ?? null;
      if (totalPages !== null && page >= totalPages) break;
      if (totalPages === null && result.length < options.perPage) break;
      if (result.length === 0) break;
    }
    return collected;
  };

  const recordBody = (
    record: DnsRecordInput,
    zoneName: string,
  ): Record<string, unknown> => {
    if (record.proxied && !CLOUDFLARE_PROXIABLE_TYPES.has(record.type)) {
      // The design's rule, enforced rather than degraded: silently writing an
      // unproxied record publishes an origin address the operator believes is
      // hidden.
      throw new CloudflareAdapterError(
        "invalid_request",
        `Cloudflare cannot proxy a ${record.type} record — only A, AAAA, and CNAME are proxiable`,
        { type: record.type, name: record.name },
      );
    }
    return {
      type: record.type,
      name: toProviderName(record.name, zoneName),
      content: record.content,
      ttl: cloudflareTtlFromLoxep(record.ttlSeconds),
      ...(record.priority === null ? {} : { priority: record.priority }),
      ...(CLOUDFLARE_PROXIABLE_TYPES.has(record.type)
        ? { proxied: record.proxied }
        : {}),
    };
  };

  return {
    baseUrl: config.baseUrl,
    sourceAccountKey,

    async listZones(options = {}) {
      const context: CloudflareErrorContext = {
        operation: "zones.list",
        path: "/zones",
      };
      const accountId = options.accountId ?? config.accountId;
      const raw = await paginate("/zones", {
        operation: "zones.list",
        query: {
          ...(options.name === undefined ? {} : { name: options.name }),
          ...(accountId === undefined ? {} : { "account.id": accountId }),
        },
        // Zones cap at 50 per page — a much smaller ceiling than DNS records,
        // and the single most likely thing for a shared pagination helper to
        // get wrong.
        perPage: CLOUDFLARE_ZONES_DEFAULT_PER_PAGE,
        maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
      });
      return raw.map((entry) => toZoneFact(entry, context));
    },

    async findZoneByName(name) {
      const zones = await this.listZones({ name, maxPages: 1 });
      return zones.find((zone) => zone.name === name) ?? null;
    },

    async getZone(externalZoneId) {
      const path = `/zones/${encodeURIComponent(externalZoneId)}`;
      const envelope = await request("GET", path, { operation: "zones.get" });
      return toZoneFact(envelope.result, { operation: "zones.get", path });
    },

    async read(subject) {
      const path = `/zones/${encodeURIComponent(subject.externalZoneId)}/dns_records`;
      const raw = await paginate(path, {
        operation: "dns.records.list",
        perPage: Math.min(
          CLOUDFLARE_RECORDS_DEFAULT_PER_PAGE,
          CLOUDFLARE_RECORDS_MAX_PER_PAGE,
        ),
        maxPages: subject.maxPages ?? DEFAULT_MAX_PAGES,
      });
      return raw.map((entry) =>
        toRecordFact(entry, subject.zoneName, {
          operation: "dns.records.list",
          path,
        }),
      );
    },

    async apply({ externalZoneId, zoneName, operations }) {
      const base = `/zones/${encodeURIComponent(externalZoneId)}/dns_records`;
      const results: DnsApplyResult[] = [];

      for (const operation of operations) {
        if (operation.kind === "create") {
          const body = recordBody(operation.record, zoneName);
          try {
            const envelope = await request("POST", base, {
              operation: "dns.records.create",
              body,
            });
            const created = asRecord(envelope.result);
            results.push({
              kind: "create",
              type: operation.record.type,
              name: operation.record.name,
              status: "applied",
              externalRecordId:
                typeof created?.["id"] === "string" ? created["id"] : null,
            });
          } catch (error) {
            // At-least-once delivery means a create can be replayed after the
            // provider already accepted it. "Already exists" is convergence,
            // not failure. The codes are empirically observed, never
            // documented (see errors.ts), so this is a widener over a retry
            // that would otherwise re-read anyway.
            const codes =
              error instanceof CloudflareAdapterError
                ? ((error.detail["providerErrors"] as
                    | Array<{ code: number }>
                    | undefined) ?? []).map((entry) => entry.code)
                : [];
            if (codes.some((code) => CLOUDFLARE_RECORD_EXISTS_CODES.has(code))) {
              results.push({
                kind: "create",
                type: operation.record.type,
                name: operation.record.name,
                status: "already_present",
                externalRecordId: null,
              });
              continue;
            }
            throw error;
          }
          continue;
        }

        if (operation.kind === "update") {
          const path = `${base}/${encodeURIComponent(operation.externalRecordId)}`;
          // PUT ("Overwrite"), not PATCH: see the module note. A desired-state
          // reconciler always knows the whole record.
          const envelope = await request("PUT", path, {
            operation: "dns.records.update",
            body: recordBody(operation.record, zoneName),
          });
          const updated = asRecord(envelope.result);
          results.push({
            kind: "update",
            type: operation.record.type,
            name: operation.record.name,
            status: "applied",
            externalRecordId:
              typeof updated?.["id"] === "string"
                ? updated["id"]
                : operation.externalRecordId,
          });
          continue;
        }

        const path = `${base}/${encodeURIComponent(operation.externalRecordId)}`;
        try {
          // Cloudflare documents this 200 body as `{"result": {"id": "..."}}`
          // with NO success/errors/messages envelope, unlike every other
          // endpoint — and that claim is UNVERIFIED against a live account.
          // The parser tolerates both shapes rather than betting on one.
          await request("DELETE", path, {
            operation: "dns.records.delete",
            tolerateBareResult: true,
          });
          results.push({
            kind: "delete",
            type: operation.record.type,
            name: operation.record.name,
            status: "applied",
            externalRecordId: operation.externalRecordId,
          });
        } catch (error) {
          if (
            error instanceof CloudflareAdapterError &&
            error.kind === "not_found"
          ) {
            // A replayed delete. Convergence, not failure.
            results.push({
              kind: "delete",
              type: operation.record.type,
              name: operation.record.name,
              status: "already_absent",
              externalRecordId: operation.externalRecordId,
            });
            continue;
          }
          throw error;
        }
      }

      return results;
    },

    capabilities() {
      return {
        provider: "cloudflare",
        proxying: true,
        proxiableTypes: [...CLOUDFLARE_PROXIABLE_TYPES],
        proxiedWildcards: true,
        wildcardRecords: true,
        automaticTtl: true,
        minTtlSeconds: CLOUDFLARE_MIN_TTL_SECONDS,
        maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
        automaticCertificateLabelDepth: 1,
      };
    },

    stats() {
      return {
        baseUrl: config.baseUrl,
        sourceAccountKey,
        rateBudget: budget.stats(),
        requests,
      };
    },
  };
}

/** Re-exported for callers that need the code set without the error module. */
export { envelopeCodes };
