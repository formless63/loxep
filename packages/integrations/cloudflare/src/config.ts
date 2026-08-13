/**
 * Typed adapter configuration (zod at the boundary). Nothing here reads
 * `process.env` — runtime credentials come from the connection model
 * (ADR-0009/ADR-0016/ADR-0019); the env-file helper in `credentials.ts` is
 * dev/test only.
 *
 * ## Auth: API tokens, never the legacy global key
 *
 * Verified against developers.cloudflare.com on 2026-08-13:
 *
 * - base URL `https://api.cloudflare.com/client/v4` (the published OpenAPI
 *   document's `servers[0].url`, described as "Client API");
 * - an API token is sent as `Authorization: Bearer <API_TOKEN>`;
 * - the legacy scheme is an `X-Auth-Email` / `X-Auth-Key` pair, and
 *   Cloudflare's own troubleshooting page warns that *"occasionally customers
 *   will attempt to use an API token with an API key syntax. Ensure you are
 *   using the Bearer option rather than the email and API key pair."*
 *
 * **Loxep implements the token scheme only.** The global API key carries every
 * permission on the account with no scoping and cannot be narrowed; a control
 * plane that edits DNS has no business holding one. This is the same call
 * `@loxep/integration-woo` makes when it refuses plain-HTTP OAuth 1.0a: the
 * omitted mode exists to make an insecure setup usable, and its failure mode
 * is a leaked credential with unlimited blast radius.
 *
 * ## Account identity is configuration, not credential
 *
 * `accountId` is deliberately NOT part of the ADR-0019 credential bundle. It
 * is non-secret provider account identity that must stay readable without a
 * decryption round-trip — the same reasoning that keeps a WooCommerce store
 * URL and a Medusa backend URL out of their bundles. The design says the same
 * thing from the schema side: `managed_domains.dns_connection_id` references
 * the connection, "whose `config` carries the account identifier".
 *
 * Zod issues are reported as `invalid_request` with paths and CODES only —
 * never the received values, which are credential material here.
 */
import { z } from "zod";
import { CloudflareAdapterError } from "./errors.ts";
import type { CloudflareAdapterLogger, RateBudget } from "./rate-budget.ts";

/** Cloudflare's REST v4 base, from the published OpenAPI `servers[0].url`. */
export const CLOUDFLARE_DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";

/**
 * `per_page` bounds, which differ per endpoint and are the single most likely
 * thing to be got wrong by a shared pagination helper.
 *
 * Verified 2026-08-13 against the published OpenAPI document:
 *
 *   GET /zones                       default 20,  min 5, MAX 50
 *   GET /zones/{id}/dns_records      default 100, min 1, max 5 000 000
 *
 * Loxep clamps DNS records to {@link CLOUDFLARE_RECORDS_MAX_PER_PAGE} rather
 * than the documented ceiling: a five-million-row page is a documented bound,
 * not a sane request, and a zone with more records than one page holds is
 * paginated normally.
 */
export const CLOUDFLARE_ZONES_MAX_PER_PAGE = 50;
export const CLOUDFLARE_ZONES_DEFAULT_PER_PAGE = 50;
export const CLOUDFLARE_RECORDS_MAX_PER_PAGE = 500;
export const CLOUDFLARE_RECORDS_DEFAULT_PER_PAGE = 100;

/**
 * TTL bounds, and the sentinel that must never reach a Loxep column.
 *
 * Verbatim from the DNS-record schema (2026-08-13): *"Time To Live (TTL) of
 * the DNS record in seconds. Setting to 1 means 'automatic'. Value must be
 * between 60 and 86400, with the minimum reduced to 30 for Enterprise
 * zones."*
 *
 * Note the inconsistency between Cloudflare's own prose (60) and its
 * machine-readable bound (30). Loxep validates against the **prose** minimum,
 * because a 30-second TTL accepted only on Enterprise zones would fail at
 * write time on every other plan, and a refusal here is legible where a
 * provider 400 is not.
 *
 * `dns_records.ttl_seconds` is nullable in Loxep and means seconds; `NULL`
 * means "let the provider choose". {@link cloudflareTtlFromLoxep} performs the
 * translation in exactly one place, which is the whole point of ADR-0009 #5.
 */
export const CLOUDFLARE_AUTOMATIC_TTL = 1;
export const CLOUDFLARE_MIN_TTL_SECONDS = 60;
export const CLOUDFLARE_MAX_TTL_SECONDS = 86_400;

/**
 * Zone status values, verbatim from the published schema's `status` enum:
 * `initializing`, `pending`, `active`, `moved`.
 *
 * **`deleted` and `deactivated` are NOT in the documented enum** even though
 * both are widely assumed to exist. The adapter therefore treats the status as
 * an OPEN set — it is retained verbatim in
 * `managed_domains.provider_zone_status` and only `active` is branched on.
 * That is exactly the evidence-preserving split the design describes:
 * `state` is Loxep's interpretation, `provider_zone_status` is what the
 * provider actually said.
 */
export const CLOUDFLARE_ZONE_STATUSES = [
  "initializing",
  "pending",
  "active",
  "moved",
] as const;
export type CloudflareZoneStatus =
  | (typeof CLOUDFLARE_ZONE_STATUSES)[number]
  | (string & {});

/**
 * The record types Cloudflare can proxy, verbatim from
 * developers.cloudflare.com/dns/proxy-status/: *"Only records used for IP
 * address resolution — A, AAAA, and CNAME records — can be proxied."*
 *
 * The published schema puts `proxied` on the shared field set that all 21
 * record types inherit, so the API will ACCEPT it anywhere. Each record's
 * read-only `proxiable` flag is the reliable per-record signal, and the
 * adapter refuses `proxied: true` on any other type rather than sending a
 * request whose flag is silently ignored — the design's rule: *"an adapter
 * must declare whether it supports proxying, and one that does not must
 * reject `proxied = true` with an `invalid_request` error rather than
 * silently writing an unproxied record. Silent degradation here means an
 * origin address is published that the operator believes is hidden."*
 */
export const CLOUDFLARE_PROXIABLE_TYPES: ReadonlySet<string> = new Set([
  "A",
  "AAAA",
  "CNAME",
]);

export const cloudflareAdapterConfigSchema = z.strictObject({
  /** The API token value. Sent as `Authorization: Bearer`, nowhere else. */
  apiToken: z.string().min(1),
  /**
   * Non-secret account identity, from `connections.config`. Optional: a
   * zone-scoped token can list its own zones without one, and the adapter
   * only sends `account.id` when it has one.
   */
  accountId: z.string().min(1).optional(),
  baseUrl: z.string().min(1).default(CLOUDFLARE_DEFAULT_BASE_URL),
  /** Per-request timeout. Cloudflare is fast; 20s is generous. */
  timeoutMs: z.number().int().positive().max(600_000).default(20_000),
});

export type CloudflareAdapterConfig = z.output<
  typeof cloudflareAdapterConfigSchema
>;

export type CloudflareAdapterConfigInput = z.input<
  typeof cloudflareAdapterConfigSchema
> & {
  logger?: CloudflareAdapterLogger;
  /**
   * Per-connection token bucket every request acquires from. When omitted the
   * adapter creates a conservative private default; pass a shared budget to
   * pool several adapters onto one Cloudflare account's budget, which matters
   * here because Cloudflare's 1200-per-five-minutes limit is per USER, not
   * per token.
   */
  rateBudget?: RateBudget;
};

/**
 * Normalize the API base URL: require https, strip trailing slashes, and
 * refuse a URL carrying its own credentials or query string.
 *
 * The `user:pass@host` rejection is credential hygiene, not pedantry: URL
 * userinfo is the one place a base URL can smuggle a secret that would then be
 * safe to log by every other rule in this package.
 */
export function normalizeCloudflareBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CloudflareAdapterError(
      "invalid_request",
      "Cloudflare baseUrl is not a valid absolute URL",
    );
  }
  if (url.protocol !== "https:") {
    throw new CloudflareAdapterError(
      "invalid_request",
      "Cloudflare baseUrl must use https:",
      { protocol: url.protocol },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new CloudflareAdapterError(
      "invalid_request",
      "Cloudflare baseUrl must not embed credentials (user:pass@host)",
    );
  }
  if (url.search !== "" || url.hash !== "") {
    throw new CloudflareAdapterError(
      "invalid_request",
      "Cloudflare baseUrl must not carry a query string or fragment",
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Parse and validate adapter config. Returns the normalized config INCLUDING
 * the token; the adapter keeps it in a closure and never re-exposes it.
 */
export function parseCloudflareAdapterConfig(
  input: Omit<CloudflareAdapterConfigInput, "logger" | "rateBudget">,
): CloudflareAdapterConfig {
  const result = cloudflareAdapterConfigSchema.safeParse(input);
  if (!result.success) {
    throw new CloudflareAdapterError(
      "invalid_request",
      "invalid Cloudflare adapter configuration",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
        })),
      },
    );
  }
  return {
    ...result.data,
    baseUrl: normalizeCloudflareBaseUrl(result.data.baseUrl),
  };
}

/**
 * Deterministic account key for this provider, computed from configuration
 * alone: `cloudflare:<accountId>`, or `cloudflare:token-scoped` when the
 * connection has no account identifier (a zone-scoped token).
 */
export function cloudflareSourceAccountKey(accountId?: string | null): string {
  return accountId === undefined || accountId === null || accountId === ""
    ? "cloudflare:token-scoped"
    : `cloudflare:${accountId}`;
}

/**
 * Loxep `ttl_seconds` -> Cloudflare `ttl`. `null` becomes the provider's
 * "automatic" sentinel (1), which is the ONE place that encoding is allowed to
 * exist. ADR-0009 #5: `1` is one provider's encoding, not a fact about DNS.
 */
export function cloudflareTtlFromLoxep(ttlSeconds: number | null): number {
  if (ttlSeconds === null) return CLOUDFLARE_AUTOMATIC_TTL;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < CLOUDFLARE_MIN_TTL_SECONDS ||
    ttlSeconds > CLOUDFLARE_MAX_TTL_SECONDS
  ) {
    throw new CloudflareAdapterError(
      "invalid_request",
      `Cloudflare TTL must be null (automatic) or between ${CLOUDFLARE_MIN_TTL_SECONDS} and ${CLOUDFLARE_MAX_TTL_SECONDS} seconds`,
      { ttlSeconds },
    );
  }
  return ttlSeconds;
}

/**
 * Cloudflare `ttl` -> Loxep `ttl_seconds`. The sentinel becomes `null`, so no
 * provider encoding survives past this function into a Loxep table or a diff.
 */
export function loxepTtlFromCloudflare(ttl: unknown): number | null {
  if (typeof ttl !== "number" || !Number.isFinite(ttl)) return null;
  return ttl === CLOUDFLARE_AUTOMATIC_TTL ? null : ttl;
}
