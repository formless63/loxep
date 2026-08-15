/**
 * `@loxep/integration-pangolin` — the Pangolin READ boundary (ADR-0009,
 * `loxep-acj.1`, milestone 1 of
 * `apps/docs/.../architecture/pangolin-chain-design.md`).
 *
 * Scope: **orgs, sites, resources, targets, rules, and org domains — read
 * only.** This milestone ships no write verb at all, structurally: there is
 * no operation this package's exported surface could use to mutate a
 * Pangolin instance.
 *
 * **No provider response type is exported from this package.** See
 * `adapter.ts` for the full verification trail — source-cited against
 * `fosrl/pangolin@main`, the envelope shape live-confirmed 2026-08-15
 * against the owner's instance, and the reachability finding that must be
 * read before wiring a connection.
 */
export { createPangolinAdapter } from "./adapter.ts";
export type {
  CreatePangolinAdapterInput,
  PangolinAdapter,
  PangolinAdapterCredentials,
  PangolinAdapterStats,
  PangolinCapabilities,
  PangolinDomainDnsRecordFact,
  PangolinDomainFact,
  PangolinFetch,
  PangolinOrgFact,
  PangolinProbeFact,
  PangolinResourceFact,
  PangolinRuleFact,
  PangolinSiteFact,
  PangolinTargetFact,
} from "./adapter.ts";

export {
  PANGOLIN_DEFAULT_TIMEOUT_MS,
  normalizePangolinBaseUrl,
  pangolinSourceAccountKey,
  parsePangolinAdapterConfig,
} from "./config.ts";
export type { PangolinAdapterConfig, PangolinAdapterConfigInput } from "./config.ts";

export {
  PANGOLIN_ERROR_KINDS,
  PangolinAdapterError,
  normalizePangolinError,
  pangolinErrorFromResponse,
  pangolinKindFromEnvelope,
  readPangolinEnvelope,
} from "./errors.ts";
export type { PangolinEnvelope, PangolinErrorContext, PangolinErrorKind } from "./errors.ts";

export {
  PANGOLIN_ALLOWED_NON_GET_PATHS,
  PANGOLIN_ALLOWED_PATH_PREFIXES,
  PANGOLIN_API_PREFIX,
  pangolinDomainDnsRecordsPath,
  pangolinDomainsPath,
  pangolinOrgPath,
  pangolinOrgSitePath,
  pangolinOrgsPath,
  pangolinResourcePath,
  pangolinResourcesPath,
  pangolinRulesPath,
  pangolinSitePath,
  pangolinSitesPath,
  pangolinTargetsPath,
} from "./operations.ts";

export {
  PANGOLIN_SUGGESTED_CAPACITY,
  PANGOLIN_SUGGESTED_REFILL_PER_SECOND,
  createRateBudget,
} from "./rate-budget.ts";
export type {
  CreateRateBudgetOptions,
  PangolinAdapterLogger,
  RateBudget,
  RateBudgetStats,
} from "./rate-budget.ts";

export {
  redactPangolinPage,
  redactPangolinResource,
  redactPangolinRule,
  redactPangolinSite,
  redactPangolinSiteCreate,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultPangolinEnvFilePath,
  loadPangolinCredentialsFromEnvFile,
} from "./credentials.ts";
export type { PangolinCredentials } from "./credentials.ts";
