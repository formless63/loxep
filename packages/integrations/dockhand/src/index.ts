/**
 * `@loxep/integration-dockhand` — the Dockhand container-management boundary
 * (ADR-0009), Phase 8 (loxep-9j6).
 *
 * Scope: **read container/stack/host state, and reconcile Dockhand's inventory
 * of managed hosts.** Container lifecycle verbs — start, stop, restart, exec,
 * deploy, redeploy, prune — are forbidden by
 * [rule 13](../../../../apps/docs/src/content/docs/architecture/domain-boundaries.md)
 * and are absent from this package by construction, asserted in
 * `test/forbidden-verbs.test.ts`.
 *
 * **No provider response type is exported from this package.** Everything
 * crossing the boundary is a Loxep-owned fact, so a consumer re-declares the
 * shapes it needs structurally and takes no dependency here.
 *
 * ## Verification trail, 2026-08-13
 *
 * The owner supplied https://finsys-dockhand.mintlify.app/api/overview as the
 * primary source and ruled explicitly that the repository's no-AI-ingestion
 * wish *"covers source, not published docs"*. **No Dockhand source was read.**
 * Every path, field, and default in this package is transcribed from the
 * documentation site's API reference pages, enumerated via its own `llms.txt`
 * manifest. `adapter.ts` and `operations.ts` record what each source
 * established, including the two places the documentation contradicts itself.
 *
 * Field names are UNVERIFIED against a running instance;
 * `test/live-dockhand.test.ts` skips cleanly until
 * `~/.config/loxep/dockhand.env` exists.
 */
export { createDockhandAdapter } from "./adapter.ts";
export type {
  CreateDockhandAdapterInput,
  DockhandAdapter,
  DockhandAdapterStats,
  DockhandCapabilities,
  DockhandContainerFact,
  DockhandFetch,
  DockhandHostApplyResult,
  DockhandHostFact,
  DockhandHostOperation,
  DockhandHostPayload,
  DockhandSessionFact,
  DockhandStackFact,
} from "./adapter.ts";

export {
  DOCKHAND_DEFAULT_TIMEOUT_MS,
  DOCKHAND_EXAMPLE_BASE_URL,
  dockhandAdapterConfigSchema,
  dockhandSourceAccountKey,
  normalizeDockhandBaseUrl,
  parseDockhandAdapterConfig,
} from "./config.ts";
export type {
  DockhandAdapterConfig,
  DockhandAdapterConfigInput,
} from "./config.ts";

export {
  DOCKHAND_ERROR_KINDS,
  DockhandAdapterError,
  dockhandErrorFromResponse,
  dockhandKindFromStatus,
  normalizeDockhandError,
  readDockhandErrorEnvelope,
} from "./errors.ts";
export type {
  DockhandErrorContext,
  DockhandErrorEnvelope,
  DockhandErrorKind,
} from "./errors.ts";

export {
  DOCKHAND_ALLOWED_NON_GET_PREFIXES,
  DOCKHAND_ALLOWED_PATH_PREFIXES,
  DOCKHAND_API_PREFIX,
  DOCKHAND_CONNECTION_TYPES,
  DOCKHAND_CONTAINERS_PATH,
  DOCKHAND_DEFAULT_PORT,
  DOCKHAND_DEFAULT_PROTOCOL,
  DOCKHAND_DEFAULT_SOCKET_PATH,
  DOCKHAND_ENVIRONMENTS_PATH,
  DOCKHAND_FORBIDDEN_MEMBER_VERBS,
  DOCKHAND_FORBIDDEN_PATH_SEGMENTS,
  DOCKHAND_LOGIN_PATH,
  DOCKHAND_MAX_LABELS,
  DOCKHAND_SESSION_PATH,
  DOCKHAND_STACKS_PATH,
  dockhandEnvironmentPath,
} from "./operations.ts";
export type { DockhandConnectionType } from "./operations.ts";

export {
  DOCKHAND_LOGIN_COST,
  DOCKHAND_SUGGESTED_CAPACITY,
  DOCKHAND_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  DockhandAdapterLogger,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  redactDockhandContainer,
  redactDockhandHost,
  redactDockhandHostPayload,
  redactDockhandStack,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultDockhandEnvFilePath,
  loadDockhandCredentialsFromEnvFile,
} from "./credentials.ts";
export type { DockhandCredentials } from "./credentials.ts";
