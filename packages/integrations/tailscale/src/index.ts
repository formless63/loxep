/**
 * `@loxep/integration-tailscale` — the Tailscale read boundary (ADR-0009,
 * loxep-4su).
 *
 * Scope: **devices in a tailnet — name, addresses, connectivity, last-seen —
 * plus a reachability/auth probe.** Nothing else: no route table, no
 * ACL/policy-file content, no key management, no device authorize/remove.
 *
 * **No provider response type is exported from this package.** See
 * `adapter.ts` for the full verification trail (owner-supplied primary
 * source: https://tailscale.com/docs/reference/tailscale-api, corroborated
 * against the pre-move `api.md` mirror, Tailscale's own Go client, and the
 * OAuth-clients documentation, all fetched 2026-08-13).
 */
export { createTailscaleAdapter } from "./adapter.ts";
export type {
  CreateTailscaleAdapterInput,
  TailscaleAdapter,
  TailscaleAdapterStats,
  TailscaleCapabilities,
  TailscaleDeviceFact,
  TailscaleFetch,
  TailscaleProbeFact,
} from "./adapter.ts";

export {
  TAILSCALE_DEFAULT_BASE_URL,
  TAILSCALE_DEFAULT_TIMEOUT_MS,
  normalizeTailscaleBaseUrl,
  parseTailscaleAdapterConfig,
  tailscaleSourceAccountKey,
} from "./config.ts";
export type {
  TailscaleAdapterConfig,
  TailscaleAdapterConfigInput,
} from "./config.ts";

export {
  TAILSCALE_ERROR_KINDS,
  TailscaleAdapterError,
  normalizeTailscaleError,
  readTailscaleErrorEnvelope,
  tailscaleErrorFromResponse,
  tailscaleKindFromStatus,
} from "./errors.ts";
export type {
  TailscaleErrorContext,
  TailscaleErrorEnvelope,
  TailscaleErrorKind,
} from "./errors.ts";

export {
  TAILSCALE_ALLOWED_NON_GET_PATHS,
  TAILSCALE_ALLOWED_PATH_PREFIXES,
  TAILSCALE_API_PREFIX,
  TAILSCALE_DEFAULT_TAILNET,
  TAILSCALE_OAUTH_TOKEN_PATH,
  tailscaleDevicePath,
  tailscaleDevicesPath,
} from "./operations.ts";

export {
  TAILSCALE_SUGGESTED_CAPACITY,
  TAILSCALE_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  RateBudget,
  RateBudgetStats,
  TailscaleAdapterLogger,
} from "./rate-budget.ts";

export {
  redactTailscaleDevice,
  redactTailscaleDevicePage,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultTailscaleEnvFilePath,
  loadTailscaleCredentialsFromEnvFile,
} from "./credentials.ts";
export type { TailscaleCredentials } from "./credentials.ts";
