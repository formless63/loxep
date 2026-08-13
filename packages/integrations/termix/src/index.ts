/**
 * `@loxep/integration-termix` — the Termix SSH-host read boundary (ADR-0009,
 * loxep-g3f).
 *
 * Scope: **an inventory of a Termix instance's SSH hosts (with best-effort
 * connectivity), and its active terminal sessions** — plus a
 * whoami-equivalent identity probe. Nothing else: no terminal exec, no
 * Docker/systemd/process control, no file manager, no credential/snippet/
 * tunnel management.
 *
 * **No provider response type is exported from this package.** See
 * `adapter.ts` for the full verification trail (owner-supplied primary
 * source: https://docs.termix.site/api/termix-api/, corroborated against
 * its generating OpenAPI document in `Termix-SSH/Docs`, both fetched
 * 2026-08-13).
 */
export { createTermixAdapter } from "./adapter.ts";
export type {
  CreateTermixAdapterInput,
  TermixAdapter,
  TermixAdapterStats,
  TermixCapabilities,
  TermixFetch,
  TermixHostFact,
  TermixProbeFact,
  TermixSessionFact,
} from "./adapter.ts";

export {
  TERMIX_DEFAULT_TIMEOUT_MS,
  TERMIX_EXAMPLE_BASE_URL,
  normalizeTermixBaseUrl,
  parseTermixAdapterConfig,
  termixSourceAccountKey,
} from "./config.ts";
export type { TermixAdapterConfig, TermixAdapterConfigInput } from "./config.ts";

export {
  TERMIX_ERROR_KINDS,
  TermixAdapterError,
  normalizeTermixError,
  readTermixErrorEnvelope,
  termixErrorFromResponse,
  termixKindFromStatus,
} from "./errors.ts";
export type {
  TermixErrorContext,
  TermixErrorEnvelope,
  TermixErrorKind,
} from "./errors.ts";

export {
  TERMIX_ACTIVE_SESSIONS_PATH,
  TERMIX_ALLOWED_NON_GET_PATHS,
  TERMIX_ALLOWED_PATHS,
  TERMIX_FORBIDDEN_MEMBER_VERBS,
  TERMIX_FORBIDDEN_PATH_SEGMENTS,
  TERMIX_HOSTS_PATH,
  TERMIX_LOGIN_PATH,
  TERMIX_ME_PATH,
  TERMIX_ME_TOKEN_PATH,
  TERMIX_STATUS_PATH,
} from "./operations.ts";

export {
  TERMIX_LOGIN_COST,
  TERMIX_SUGGESTED_CAPACITY,
  TERMIX_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
  TermixAdapterLogger,
} from "./rate-budget.ts";

export {
  redactTermixHost,
  redactTermixSession,
  redactTermixSessionPage,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultTermixEnvFilePath,
  loadTermixCredentialsFromEnvFile,
} from "./credentials.ts";
export type { TermixCredentials } from "./credentials.ts";
