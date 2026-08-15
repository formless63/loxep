/**
 * `@loxep/integration-gatus` — the Gatus fleet-observability read boundary
 * (Phase 8 milestone 4, loxep-ovj.4).
 *
 * Scope: read the operator's Gatus endpoint statuses when the auth mode
 * allows it, plus the unauthenticated process-health probe and the
 * always-unauthenticated per-endpoint uptime/response-time fallback. No
 * metric history, no suites, no alerts, no writes. See `adapter.ts` for the
 * full auth-branch design and its source citations.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact.
 *
 * ## Verification trail, 2026-08-13
 *
 * gatus.io/docs is a client-rendered SPA and returns an empty body to a
 * fetcher, so it is unusable as a reference — every route, response shape,
 * and auth behavior here is verified against `github.com/TwiN/gatus` tag
 * `v5.36.0`'s own Go source (`api/api.go`, `api/config.go`,
 * `api/endpoint_status.go`, `api/raw.go`, `security/config.go`,
 * `security/oidc.go`, `config/endpoint/status.go`, `config/endpoint/result.go`,
 * `config/key/key.go`, `storage/store/store.go`, and `github.com/TwiN/health`).
 * `test/live-gatus.test.ts` skips cleanly until `~/.config/loxep/gatus.env`
 * exists and is the standing job to confirm live behavior beyond the source
 * reading.
 *
 * **Live-run update, 2026-08-14.** That standing job ran against one real
 * instance: the unauthenticated health and config probes both answered as
 * documented, `listEndpointStatuses()`/the OIDC-refusal path behaved
 * correctly for the mode that instance was actually in, and `capabilities()`
 * issued exactly one probe. Only one instance in one posture was exercised —
 * see `operations.ts`'s "three-way posture … is an INFERENCE" section for
 * exactly what that does and does not confirm about the open/basic/oidc
 * distinction, and why that distinction stays copy-only regardless.
 */
export { createGatusAdapter } from "./adapter.ts";
export type {
  CreateGatusAdapterInput,
  GatusAdapter,
  GatusAdapterStats,
  GatusAuthMode,
  GatusAuthProbeFact,
  GatusCapabilities,
  GatusEndpointStatusFact,
  GatusFetch,
  GatusHealthFact,
  GatusResponseTimeFact,
  GatusUptimeDuration,
  GatusUptimeFact,
} from "./adapter.ts";

export {
  GATUS_DEFAULT_TIMEOUT_MS,
  GATUS_EXAMPLE_BASE_URL,
  gatusAdapterConfigSchema,
  gatusSourceAccountKey,
  normalizeGatusBaseUrl,
  parseGatusAdapterConfig,
} from "./config.ts";
export type { GatusAdapterConfig, GatusAdapterConfigInput } from "./config.ts";

export {
  GATUS_ERROR_KINDS,
  GatusAdapterError,
  gatusErrorFromResponse,
  gatusKindFromStatus,
  normalizeGatusError,
  readGatusErrorMessage,
} from "./errors.ts";
export type { GatusErrorContext, GatusErrorKind } from "./errors.ts";

export {
  GATUS_ALLOWED_PATH_PATTERNS,
  GATUS_CONFIG_PATH,
  GATUS_ENDPOINT_STATUSES_PATH,
  GATUS_HEALTH_PATH,
  GATUS_UPTIME_DURATIONS,
  assertGatusUptimeDuration,
  gatusEndpointResponseTimePath,
  gatusEndpointUptimePath,
  isGatusAllowedPath,
} from "./operations.ts";

export {
  GATUS_SUGGESTED_CAPACITY,
  GATUS_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  GatusAdapterLogger,
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  redactGatusConfigProbe,
  redactGatusEndpointStatus,
  redactGatusEndpointStatusList,
  redactGatusHealth,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultGatusEnvFilePath,
  loadGatusCredentialsFromEnvFile,
} from "./credentials.ts";
export type { GatusCredentials } from "./credentials.ts";

// Alert-evidence ingestion (Phase 8 milestone 7, loxep-ovj.7): the JSON
// contract Loxep publishes for Gatus's `custom` alerting provider, and the
// normalizer + feedback-latch check `@loxep/app`'s fleet-evidence receiver
// dispatches to. See webhook.ts's module doc.
export {
  gatusAlertWebhookSchema,
  gatusExternalEndpointKey,
  normalizeGatusAlertWebhook,
} from "./webhook.ts";
export type {
  GatusAlertWebhookPayload,
  GatusEvidenceAccepted,
  GatusEvidenceDropped,
  GatusEvidenceNormalization,
  NormalizeGatusAlertWebhookOptions,
} from "./webhook.ts";
