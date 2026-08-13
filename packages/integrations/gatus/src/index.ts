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
