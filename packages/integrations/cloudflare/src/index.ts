/**
 * `@loxep/integration-cloudflare` — the Cloudflare DNS boundary (ADR-0009),
 * Phase 7 milestone 1 (loxep-lmy.1).
 *
 * Scope of this milestone: **zones and DNS records**, read and apply. API
 * tokens (`POST /user/tokens`, the mint-a-credential-for-a-host workflow) are
 * milestone 3 and deliberately absent — except for
 * {@link redactCloudflareTokenCreate}, which ships early so the rule that a
 * token value never reaches a run step exists before the code that could
 * violate it.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so `@loxep/infrastructure`
 * re-declares the shapes it needs structurally and takes no dependency on this
 * package — the discipline `@loxep/commerce` already applies to the eBay fact
 * types.
 *
 * Every operation name, bound, and status vocabulary here was verified against
 * developers.cloudflare.com and the official `cloudflare/api-schemas` OpenAPI
 * document on **2026-08-13**; the verification trail is in each module's
 * header. Seven facts are explicitly marked UNVERIFIED in `errors.ts` and
 * `adapter.ts` — treat them as unconfirmed until checked against a live
 * account, exactly as the Medusa and eBay adapters do.
 */
export {
  createCloudflareAdapter,
  toLoxepName,
  toProviderName,
} from "./adapter.ts";
export type {
  CloudflareAdapter,
  CloudflareAdapterStats,
  CloudflareDnsRecordFact,
  CloudflareFetch,
  CloudflareZoneFact,
  CreateCloudflareAdapterInput,
  DnsApplyOperation,
  DnsApplyResult,
  DnsProviderCapabilities,
  DnsRecordInput,
} from "./adapter.ts";

export {
  CLOUDFLARE_AUTOMATIC_TTL,
  CLOUDFLARE_DEFAULT_BASE_URL,
  CLOUDFLARE_MAX_TTL_SECONDS,
  CLOUDFLARE_MIN_TTL_SECONDS,
  CLOUDFLARE_PROXIABLE_TYPES,
  CLOUDFLARE_RECORDS_DEFAULT_PER_PAGE,
  CLOUDFLARE_RECORDS_MAX_PER_PAGE,
  CLOUDFLARE_ZONE_STATUSES,
  CLOUDFLARE_ZONES_DEFAULT_PER_PAGE,
  CLOUDFLARE_ZONES_MAX_PER_PAGE,
  cloudflareAdapterConfigSchema,
  cloudflareSourceAccountKey,
  cloudflareTtlFromLoxep,
  loxepTtlFromCloudflare,
  normalizeCloudflareBaseUrl,
  parseCloudflareAdapterConfig,
} from "./config.ts";
export type {
  CloudflareAdapterConfig,
  CloudflareAdapterConfigInput,
  CloudflareZoneStatus,
} from "./config.ts";

export {
  CLOUDFLARE_AUTH_ERROR_CODES,
  CLOUDFLARE_ERROR_KINDS,
  CLOUDFLARE_NO_ROUTE_CODE,
  CLOUDFLARE_RECORD_EXISTS_CODES,
  CloudflareAdapterError,
  cloudflareErrorFromResponse,
  cloudflareKindFromStatus,
  envelopeCodes,
  normalizeCloudflareError,
  readCloudflareEnvelope,
} from "./errors.ts";
export type {
  CloudflareEnvelope,
  CloudflareEnvelopeError,
  CloudflareErrorContext,
  CloudflareErrorKind,
} from "./errors.ts";

export {
  CLOUDFLARE_GLOBAL_LIMIT_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  CloudflareAdapterLogger,
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  redactCloudflareDnsRecord,
  redactCloudflareRequest,
  redactCloudflareTokenCreate,
  redactCloudflareZone,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultCloudflareEnvFilePath,
  loadCloudflareCredentialsFromEnvFile,
} from "./credentials.ts";
export type { CloudflareCredentials } from "./credentials.ts";
