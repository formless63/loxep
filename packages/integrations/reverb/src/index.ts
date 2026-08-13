/**
 * @loxep/integration-reverb — Loxep's Reverb integration boundary (ADR-0009,
 * loxep-g4t.3). Reverb has no first-party maintained Node/TypeScript SDK, so
 * this package calls it directly with native `fetch` (like
 * `@loxep/integration-woo`/`-etsy`/`-medusa`), never
 * `@loxep/integration-ebay`'s `ebay-api` pattern. Provider payloads cross
 * this boundary as `Record<string, unknown>`; no provider type is exported.
 *
 * Design: `apps/docs/src/content/docs/architecture/reverb-integration-design.md`.
 * m1 scope: config, error taxonomy, a per-connection rate budget, dev
 * credentials, decimal-string money pass-through, single-token bearer auth,
 * listing/my-listings reads, and observation mapping. Orders (`orders.ts`)
 * are m2, deliberately not in this package yet.
 */

export {
  REVERB_ERROR_KINDS,
  ReverbAdapterError,
  normalizeReverbError,
  readReverbErrorBody,
  reverbErrorFromResponse,
  reverbKindFromStatus,
} from "./errors.ts";
export type {
  ReverbErrorContext,
  ReverbErrorKind,
  ReverbProviderErrorBody,
} from "./errors.ts";

export { createRateBudget } from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
  ReverbAdapterLogger,
} from "./rate-budget.ts";

export {
  REVERB_API_BASE_URL,
  REVERB_API_VERSION,
  parseReverbAdapterConfig,
  reverbAdapterConfigSchema,
  reverbSourceAccountKey,
} from "./config.ts";
export type { ReverbAdapterConfig, ReverbAdapterConfigInput } from "./config.ts";

export {
  defaultDevEnvFilePath,
  loadDevCredentialsFromEnvFile,
} from "./credentials.ts";
export type { ReverbDevCredentials } from "./credentials.ts";

export {
  decimalFromReverbMoney,
  normalizeReverbMoney,
  reverbMoneyCurrency,
} from "./money.ts";
export type { ReverbMoney } from "./money.ts";

export { createReverbAdapter } from "./adapter.ts";
export type {
  CreateReverbAdapterInput,
  GetMyListingsInput,
  ReverbAccount,
  ReverbAdapter,
  ReverbAdapterStats,
  ReverbFetch,
  ReverbListingStateFilter,
  ReverbListPage,
  ReverbQuery,
  ReverbQueryValue,
} from "./adapter.ts";

export {
  OBSERVATION_HASH_FIELDS,
  REVERB_LISTING_STATE_MAP,
  REVERB_LISTING_STATES,
  REVERB_MARKETPLACE,
  mapListingToSnapshot,
  mapReverbListingState,
  observationStateHash,
  snapshotToObservation,
} from "./observation.ts";
export type {
  ReverbListingSnapshot,
  ReverbListingState,
  ReverbMarketplaceItemIdentity,
  ReverbObservation,
  ReverbObservationContext,
  ReverbObservationItem,
} from "./observation.ts";

export { probeConnection } from "./probe.ts";
export type { ReverbProbeResult } from "./probe.ts";
