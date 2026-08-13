/**
 * `@loxep/integration-purelymail` — the Purelymail mail-hosting boundary
 * (ADR-0009), Phase 7 milestone 2 (loxep-lmy.2).
 *
 * Scope of this milestone: **domains, ownership verification, mailboxes, and
 * routing rules** — everything the infrastructure design's mail section needs
 * and nothing else. `createAppPassword` is named in `operations.ts` and
 * deliberately unimplemented; password-reset methods likewise.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so `@loxep/infrastructure`
 * re-declares the shapes it needs structurally and takes no dependency on this
 * package — the discipline `@loxep/commerce` already applies to the eBay fact
 * types and `@loxep/infrastructure` already applies to Cloudflare's.
 *
 * ## Verification trail, 2026-08-13
 *
 * Two upstream sources, both current, both recorded in the module that uses
 * them:
 *
 * 1. the provider's OpenAPI document, `window.swaggerSpec` in
 *    `https://news.purelymail.com/api/swagger-spec.js` (the script the Swagger
 *    UI at `news.purelymail.com/api/index.html` loads — the page itself is an
 *    empty shell and cannot be read directly), `info.version` "0.0.1", 19
 *    paths, all transcribed into `operations.ts`;
 * 2. `https://purelymail.com/docs/domainDocs`, the provider's own custom-domain
 *    instructions, which is where the seven required DNS records in
 *    `records.ts` come from — the design refused to list them precisely so they
 *    would be fetched rather than remembered.
 *
 * Plus three **live probes** against the real API (unauthenticated, read-only,
 * creating nothing), which established the fact that matters most here: an
 * authentication failure arrives as **HTTP 200** carrying
 * `{"type":"error","code":"invalidToken"}`. See `errors.ts`.
 *
 * Every operation NAME remains marked UNVERIFIED until exercised against a live
 * account. `test/live-purelymail.test.ts` skips cleanly until
 * `~/.config/loxep/purelymail.env` exists.
 */
export { createPurelymailAdapter } from "./adapter.ts";
export type {
  CreatePurelymailAdapterInput,
  CreateRoutingRuleInput,
  CreateUserInput,
  MailProviderCapabilities,
  PurelymailAdapter,
  PurelymailAdapterStats,
  PurelymailDnsSummaryFact,
  PurelymailDomainFact,
  PurelymailFetch,
  PurelymailRoutingRuleFact,
} from "./adapter.ts";

export {
  PURELYMAIL_DEFAULT_BASE_URL,
  PURELYMAIL_DEFAULT_TIMEOUT_MS,
  PURELYMAIL_LIST_USER_LIMIT,
  PURELYMAIL_TOKEN_HEADER,
  normalizePurelymailBaseUrl,
  parsePurelymailAdapterConfig,
  purelymailAdapterConfigSchema,
  purelymailFullAddress,
  purelymailSourceAccountKey,
} from "./config.ts";
export type {
  PurelymailAdapterConfig,
  PurelymailAdapterConfigInput,
} from "./config.ts";

export {
  PURELYMAIL_ALREADY_EXISTS_ERROR_CODES,
  PURELYMAIL_AUTH_ERROR_CODES,
  PURELYMAIL_ERROR_KINDS,
  PURELYMAIL_NOT_FOUND_ERROR_CODES,
  PurelymailAdapterError,
  normalizePurelymailError,
  purelymailErrorFromResponse,
  purelymailKindFromEnvelope,
  readPurelymailEnvelope,
} from "./errors.ts";
export type {
  PurelymailEnvelope,
  PurelymailErrorContext,
  PurelymailErrorKind,
} from "./errors.ts";

export {
  PURELYMAIL_API_PREFIX,
  PURELYMAIL_OPERATIONS,
  purelymailPath,
} from "./operations.ts";
export type { PurelymailOperation } from "./operations.ts";

export {
  PURELYMAIL_DKIM_SELECTORS,
  PURELYMAIL_DMARC_CONTENT,
  PURELYMAIL_DMARC_NAME,
  PURELYMAIL_MX_HOST,
  PURELYMAIL_MX_PRIORITY,
  PURELYMAIL_RECORD_COUNT,
  PURELYMAIL_SPF_CONTENT,
  purelymailBaseRecords,
  purelymailOwnershipRecord,
  purelymailRequiredRecords,
} from "./records.ts";
export type { PurelymailDnsRecord } from "./records.ts";

export {
  PURELYMAIL_SUGGESTED_CAPACITY,
  PURELYMAIL_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  PurelymailAdapterLogger,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  redactPurelymailDomain,
  redactPurelymailOwnershipCode,
  redactPurelymailRequest,
  redactPurelymailRoutingRule,
  redactPurelymailUserCreate,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultPurelymailEnvFilePath,
  loadPurelymailCredentialsFromEnvFile,
} from "./credentials.ts";
export type { PurelymailCredentials } from "./credentials.ts";
