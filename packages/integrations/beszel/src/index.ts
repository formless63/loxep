/**
 * `@loxep/integration-beszel` — the Beszel fleet-metrics boundary (ADR-0009),
 * Phase 8 (loxep-9j6).
 *
 * Scope: **read the current status of every system the hub will show a readonly
 * user, plus an unauthenticated reachability probe.** Nothing else. No metric
 * series, no alerts, no writes — see `adapter.ts` for why each of those is out.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so a consumer re-declares the
 * shapes it needs structurally and takes no dependency here.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://beszel.dev/guide/rest-api as the primary source,
 * and re-verifying it overturned the fleet-observability design's gating
 * claim: Beszel does **not** require a superuser credential for a read. A
 * `readonly` role exists in the ordinary `users` collection
 * (https://beszel.dev/guide/user-accounts), which is what this adapter
 * authenticates as. The wire contract is PocketBase's
 * (https://pocketbase.io/docs/api-records/). Every consequence of those three
 * sources is recorded in the module that depends on it, not here.
 *
 * Field names inside a `systems` record are **UNVERIFIED** beyond `id`,
 * `status`, and `users`; `test/live-beszel.test.ts` skips cleanly until
 * `~/.config/loxep/beszel.env` exists and is the standing job to confirm them.
 */
export { createBeszelAdapter } from "./adapter.ts";
export type {
  BeszelAdapter,
  BeszelAdapterStats,
  BeszelCapabilities,
  BeszelFetch,
  BeszelHealthFact,
  BeszelSystemFact,
  CreateBeszelAdapterInput,
} from "./adapter.ts";

export {
  BESZEL_DEFAULT_TIMEOUT_MS,
  BESZEL_EXAMPLE_BASE_URL,
  beszelAdapterConfigSchema,
  beszelSourceAccountKey,
  normalizeBeszelBaseUrl,
  parseBeszelAdapterConfig,
} from "./config.ts";
export type {
  BeszelAdapterConfig,
  BeszelAdapterConfigInput,
} from "./config.ts";

export {
  BESZEL_ERROR_KINDS,
  BeszelAdapterError,
  beszelErrorFromResponse,
  beszelKindFromStatus,
  normalizeBeszelError,
  readBeszelErrorEnvelope,
} from "./errors.ts";
export type {
  BeszelErrorContext,
  BeszelErrorEnvelope,
  BeszelErrorKind,
} from "./errors.ts";

export {
  BESZEL_ALLOWED_NON_GET_PATHS,
  BESZEL_ALLOWED_PATHS,
  BESZEL_API_PREFIX,
  BESZEL_AUTH_PATH,
  BESZEL_HEALTH_PATH,
  BESZEL_LIST_PER_PAGE,
  BESZEL_MAX_LIST_PAGES,
  BESZEL_SUPERUSERS_COLLECTION,
  BESZEL_SYSTEMS_COLLECTION,
  BESZEL_SYSTEMS_PATH,
  BESZEL_USERS_COLLECTION,
} from "./operations.ts";

export {
  BESZEL_SUGGESTED_CAPACITY,
  BESZEL_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  BeszelAdapterLogger,
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  redactBeszelHealth,
  redactBeszelSystem,
  redactBeszelSystemPage,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultBeszelEnvFilePath,
  loadBeszelCredentialsFromEnvFile,
} from "./credentials.ts";
export type { BeszelCredentials } from "./credentials.ts";

// Alert-evidence ingestion (Phase 8 milestone 7, loxep-ovj.7): the
// Shoutrrr-generic-webhook JSON shape Beszel's own guide documents, and the
// normalizer `@loxep/app`'s fleet-evidence receiver dispatches to. See
// webhook.ts's module doc.
export {
  beszelAlertWebhookSchema,
  normalizeBeszelAlertWebhook,
} from "./webhook.ts";
export type {
  BeszelAlertWebhookPayload,
  BeszelEvidenceAccepted,
  BeszelEvidenceDropped,
  BeszelEvidenceNormalization,
} from "./webhook.ts";
