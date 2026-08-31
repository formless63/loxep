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
 * `fosrl/pangolin@main`, with the shared envelope live-probed through an
 * unauthenticated sibling route. Bearer-authenticated reads require an
 * explicitly exposed Integration API origin and remain opt-in.
 */
export { createPangolinAdapter } from "./adapter.ts";
export type {
  CreatePangolinAdapterInput,
  PangolinAdapter,
  PangolinAdapterCredentials,
  PangolinAdapterStats,
  PangolinCapabilities,
  PangolinCreateResourcePayload,
  PangolinCreateTargetPayload,
  PangolinDomainDnsRecordFact,
  PangolinDomainFact,
  PangolinFetch,
  PangolinOrgFact,
  PangolinProbeFact,
  PangolinResourceFact,
  PangolinRuleFact,
  PangolinRulePayload,
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
  PANGOLIN_ALLOWED_PATH_PREFIXES,
  PANGOLIN_ALLOWED_WRITE_SHAPES,
  PANGOLIN_API_PREFIX,
  isAllowedPangolinWrite,
  pangolinCreateResourcePath,
  pangolinCreateRulePath,
  pangolinCreateTargetPath,
  pangolinDomainDnsRecordsPath,
  pangolinDomainsPath,
  pangolinOrgPath,
  pangolinOrgSitePath,
  pangolinOrgsPath,
  pangolinResourcePath,
  pangolinResourcesPath,
  pangolinRulePath,
  pangolinRulesPath,
  pangolinSitePath,
  pangolinSitesPath,
  pangolinTargetsPath,
} from "./operations.ts";
export type { PangolinWriteShape } from "./operations.ts";

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
  redactPangolinTarget,
} from "./redact.ts";
export type { RedactedSummary } from "./redact.ts";

export {
  defaultPangolinEnvFilePath,
  loadPangolinCredentialsFromEnvFile,
} from "./credentials.ts";
export type { PangolinCredentials } from "./credentials.ts";
