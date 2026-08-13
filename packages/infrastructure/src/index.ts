/**
 * `@loxep/infrastructure` — the Infrastructure control plane's domain services
 * (Phase 7, milestone 1, loxep-lmy.1).
 *
 * ```text
 * Loxep OWNS      declared intent for names and DNS, and the reconciliation of
 *                 that intent against the providers that hold it
 * Loxep OBSERVES  provider state, the diff against intent, delegation status
 * Loxep NEVER     configuration management, image builds, deployment
 *                 pipelines, server provisioning, or anything that runs ON a
 *                 host
 * ```
 *
 * Nothing in this package can restart a container, reboot a host, or run a
 * command. Its entire vocabulary is DNS records and hostname routing, and that
 * is the line the Master Domain Map's "not an infrastructure management
 * platform" non-goal is held to.
 *
 * **This package takes no dependency on an integration package.** The provider
 * contract is `port.ts`, re-declared structurally; the composition root holds
 * `@loxep/integration-cloudflare` and passes an adapter in. It takes no
 * dependency on `@loxep/market` either — the scheduling target type is
 * registered there and executed here, never the reverse.
 *
 * ## What ships in milestone 1
 *
 * ```text
 * materialize.ts  PURE intent -> DesiredRecord[], with the fronting-node hop
 * reconcile.ts    PURE diff, and the operations a diff implies
 * sync.ts         the DB+provider run: read, diff, apply, record
 * drift.ts        findings, upserted against the unresolved partial unique
 * domains.ts      managed domains and desired records; transactional enqueue
 * targets.ts      hosting targets and the one-hop fronting guard
 * operations.ts   the provider_operations idempotency ledger
 * tasks.ts        materialize-records / sync-records, and add_job through a tx
 * ```
 *
 * ## What milestone 2 adds (loxep-lmy.2)
 *
 * ```text
 * mail.ts         templates, mail enablement, mailbox INTENT
 * mail-port.ts    the mail provider contract, re-declared structurally
 * mail-sync.ts    the resumable mail reconciler AND THE DELEGATION GATE
 * ```
 *
 * Its one load-bearing idea, in one sentence: mail provisioning contains a step
 * that takes **days and is performed by a human at a registrar**, so the whole
 * workflow is a resumable desired-state loop that advances as far as it can and
 * records where it stopped — never a script that has to run to completion.
 * `isDelegationConfirmed` is the gate that keeps it from spending provider
 * calls on a question DNS cannot yet answer.
 *
 * Minted tokens and the `/infrastructure` workspace (milestone 3) are
 * deliberately absent, as is any path that reads a stored mailbox password
 * back — `MailboxSecretWriter` has no read member at all.
 *
 * ## What Phase 8 adds (loxep-9j6)
 *
 * ```text
 * container-host-port.ts   the container-host contract + desired-state planner
 * ```
 *
 * One seam, and it is deliberately types-plus-a-pure-function: the owner's
 * 2026-08-13 rule-13 carve-out lets Loxep reconcile a container manager's
 * INVENTORY OF HOSTS (registering a machine writes a row in the manager's own
 * table; it runs nothing on that machine), while container lifecycle verbs stay
 * forbidden. It ships **with no migration**, because the join key is the
 * already-unique host NAME on both sides rather than a stored provider id —
 * see the module doc for the limitation that accepts, and for why
 * `hosting_targets` gains no provider column.
 *
 * **Not yet wired to a job.** There is no `infrastructure.sync-container-hosts`
 * task, because the desired state a caller would assemble depends on where the
 * per-host connection detail lives, which is a `/infrastructure` surface
 * question this issue does not answer. The port and planner exist so that
 * milestone lands as wiring rather than as design.
 */
export {
  InfrastructureError,
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  MaterializationError,
  ProviderCallError,
} from "./errors.ts";

export {
  caaContent,
  materializeCaaRecords,
  materializeDesiredRecords,
  resolveHostingAddress,
} from "./materialize.ts";
export type {
  CaaPolicy,
  DesiredRecord,
  HostingTargetNode,
  MaterializeInput,
  ResolvedHostingAddress,
} from "./materialize.ts";

export {
  applyOperationsFor,
  assertNoUnexpectedDeletions,
  diffDnsRecords,
} from "./reconcile.ts";
export type {
  DnsDiff,
  DnsDiffEntry,
  IntentRecord,
  MissingDiff,
  ModifiedDiff,
  ReconcileProvider,
  UnchangedDiff,
  UnexpectedDiff,
} from "./reconcile.ts";

export type {
  DnsApplyOperation,
  DnsApplyResult,
  DnsProviderCapabilities,
  DnsProviderPort,
  DnsRecordPayload,
  ObservedDnsRecord,
  ProviderZone,
  ResponseRedactor,
} from "./port.ts";

export { createDriftService, findingsFromDiff } from "./drift.ts";
export type {
  DnsDriftFindingRow,
  DriftFindingInput,
  DriftService,
} from "./drift.ts";

export {
  MANAGED_DOMAIN_RESOURCE_TYPE,
  MATERIALIZE_RECORDS_TASK,
  SYNC_RECORDS_TASK,
  createManagedDomainsService,
  domainJobKey,
} from "./domains.ts";
export type {
  CreateManagedDomainInput,
  DnsRecordRow,
  ManagedDomainRow,
  ManagedDomainsService,
  ManualRecordInput,
  TransactionalEnqueue,
  UpdateDomainIntentInput,
} from "./domains.ts";

export {
  HOSTING_TARGET_RESOURCE_TYPE,
  createHostingTargetsService,
} from "./targets.ts";
export type {
  CreateHostingTargetInput,
  HostingTargetRow,
  HostingTargetsService,
} from "./targets.ts";

export {
  createProviderOperationsLedger,
  idempotencyKey,
} from "./operations.ts";
export type {
  BeginOutcome,
  ProviderOperationRow,
  ProviderOperationsLedger,
} from "./operations.ts";

export { createRecordSyncService } from "./sync.ts";
export type {
  ReconcileRunRow,
  RecordSyncService,
  RunRecordSyncInput,
  RunRecordSyncResult,
} from "./sync.ts";

export {
  createRecordingEnqueue,
  createTransactionalEnqueue,
  jobKeysInQueue,
  SYNC_PROXY_RESOURCE_TASK,
} from "./tasks.ts";
// SYNC_TOKEN_POLICY_TASK / SYNC_TOKEN_POLICY_RUN_KIND / tokenJobKey are
// re-exported by tasks.ts internally too (so a caller who only imports
// tasks.ts gets the full task-name set), but the package's own public
// surface takes them from tokens.ts, their defining module — see the
// "tokens (milestone 3)" section below, matching how MATERIALIZE_RECORDS_TASK
// and ENSURE_MAIL_DOMAIN_TASK are taken from domains.ts / mail.ts rather than
// from tasks.ts.
export type {
  EnsureMailDomainPayload,
  MaterializeRecordsPayload,
  PollMailOwnershipPayload,
  SyncMailboxesPayload,
  SyncProxyResourcePayload,
  SyncRecordsPayload,
  SyncTokenPolicyPayload,
} from "./tasks.ts";

/* ------------------------------------------------- mail (milestone 2) ---- */

export {
  ENSURE_MAIL_DOMAIN_TASK,
  MAILBOX_RESOURCE_TYPE,
  MAILBOX_TEMPLATE_RESOURCE_TYPE,
  MAIL_DOMAIN_RESOURCE_TYPE,
  POLL_MAIL_OWNERSHIP_TASK,
  SYNC_MAILBOXES_TASK,
  createMailDomainsService,
  createMailboxTemplatesService,
} from "./mail.ts";
export type {
  ApplyTemplateResult,
  CreateMailboxTemplateInput,
  EnableMailInput,
  MailDomainRow,
  MailDomainsService,
  MailboxInput,
  MailboxRow,
  MailboxTemplateEntryInput,
  MailboxTemplateEntryRow,
  MailboxTemplateRow,
  MailboxTemplatesService,
} from "./mail.ts";

export { planContainerHostOperations } from "./container-host-port.ts";
export type {
  ContainerHostApplyResult,
  ContainerHostOperation,
  ContainerHostPayload,
  ContainerHostPlan,
  ContainerHostProviderCapabilities,
  ContainerHostProviderPort,
  DesiredContainerHost,
  ObservedContainerHost,
} from "./container-host-port.ts";

export type {
  CreateMailRoutingRuleInput,
  CreateMailUserInput,
  MailDnsRecord,
  MailDnsSummary,
  MailDomainState,
  MailProviderCapabilities,
  MailProviderPort,
  MailRoutingRule,
  MailboxSecretWriter,
  PasswordMinter,
} from "./mail-port.ts";

export {
  MAILBOX_RUN_KIND,
  MAIL_DOMAIN_RUN_KIND,
  createMailSyncService,
  defaultPasswordMinter,
  isDelegationConfirmed,
  nextState,
} from "./mail-sync.ts";
export type {
  CreateMailSyncServiceOptions,
  MailDomainOutcome,
  MailDomainSyncResult,
  MailSyncService,
  MailboxSyncResult,
  RunMailSyncInput,
} from "./mail-sync.ts";

/* ------------------------------------------------- tokens (milestone 3) --- */

export {
  DNS_PROVIDER_TOKEN_RESOURCE_TYPE,
  SYNC_TOKEN_POLICY_RUN_KIND,
  SYNC_TOKEN_POLICY_TASK,
  createDnsProviderTokensService,
  dnsProviderTokenSecretKey,
  tokenJobKey,
} from "./tokens.ts";
export type {
  DnsProviderTokenRow,
  DnsProviderTokensService,
  MintDnsProviderTokenInput,
  RevealedDnsProviderToken,
  SetDnsProviderTokenZonesInput,
  SyncTokenPolicyResult,
} from "./tokens.ts";

export type {
  DnsTokenMintInput,
  DnsTokenMintResult,
  DnsTokenProviderPort,
  DnsTokenRollResult,
  TransactionalDnsTokenSecretWriter,
} from "./token-port.ts";

/**
 * The monitor target type this domain registers against the SHARED scheduling
 * model (design open question 5, PROVISIONAL). Declared here so the
 * composition root can route without importing `@loxep/market` twice; the
 * closed list itself lives in `@loxep/market`, which owns the mechanism.
 */
export const INFRASTRUCTURE_DOMAIN_RECONCILE_TARGET_TYPE =
  "infrastructure_domain_reconcile";

/** The namespaced `config` key this domain owns on that row. */
export const INFRA_SYNC_CONFIG_KEY = "infraSync";
