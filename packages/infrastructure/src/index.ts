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
 * ## What Phase 8 adds (loxep-9j6, extended by loxep-hb7 Milestone C)
 *
 * ```text
 * container-host-port.ts   the container-host contract + desired-state planner
 * container-hosts.ts       infrastructure.reconcile-container-host — the wired job
 * ```
 *
 * One seam, and it is deliberately types-plus-a-pure-function: the owner's
 * 2026-08-13 rule-13 carve-out lets Loxep reconcile a container manager's
 * INVENTORY OF HOSTS (registering a machine writes a row in the manager's own
 * table; it runs nothing on that machine), while container lifecycle verbs stay
 * forbidden. It ships **with no migration**, because the join key is the
 * already-unique host NAME on both sides rather than a stored provider id,
 * self-retiring into a `external_resources`/`resource_links` id once a match
 * succeeds (`DesiredContainerHost.externalHostId`) — see the module doc for
 * the limitation the bootstrap accepts, and for why `hosting_targets` gains
 * no provider column.
 *
 * **Now wired to a job.** `infrastructure.reconcile-container-host`
 * (`container-hosts.ts`) is `planContainerHostOperations`' first non-test
 * caller — desired state assembled from a `hosting_targets` row plus its
 * dockhand/environment companion link's `external_resources.metadata`, with
 * write-only TLS/Hawser material resolved from `application_secrets` only
 * when an apply might need it. The composition root (`@loxep/app`) supplies
 * the `ContainerHostProviderPort` and the secret reader; this package still
 * takes no dependency on `@loxep/integration-dockhand`.
 *
 * ## What loxep-89h adds (rf4/Tailscale slice A leftover)
 *
 * ```text
 * tailnet-address.ts   PURE CGNAT/ULA containment predicate, no DB, no network
 * ```
 *
 * `resolveHostingAddress` refuses (`MaterializationError`) rather than
 * publishes a `hosting_targets.address_v4`/`address_v6` that falls inside
 * Tailscale's private ranges — see the module for why, and `tailnet-address.ts`
 * for the two verified CIDR literals. Exported here so `apps/web`'s fleet
 * detail warning classifies the SAME stored address the SAME way, instead of
 * carrying a second copy of the prefixes that could drift from this one.
 *
 * ## What the Pangolin chain design's milestone 2 adds (loxep-acj.2)
 *
 * ```text
 * proxy-port.ts   the proxy provider contract + desired-state planner —
 *                 `container-host-port.ts`'s template, copied and hardened:
 *                 the operation union's missing `delete` is now PERMANENT
 *                 (Pangolin's `enabled` flag makes retirement reversible)
 * proxy.ts        infrastructure.sync-proxy-resource's service — CHECK MODE
 *                 ONLY, structurally refusing `mode: 'apply'` until the
 *                 write-authorization gate (milestone 3, loxep-acj.3) ships
 * ```
 *
 * Lands the reserved contract `tasks.ts` has carried since Phase 7 milestone
 * 3: `SYNC_PROXY_RESOURCE_TASK` / `SyncProxyResourcePayload` finally have a
 * service behind them, and `hosting_targets.proxy_connection_id` (nullable
 * since migration `0012`, unused since) drives something real for the first
 * time — resolving which Pangolin CONNECTION a given resource's reconcile
 * runs against. Two new intent tables, `proxy_resources` and
 * `proxy_resource_rules` (migration `0027`), following `dns_records.owner`'s
 * per-row-ownership precedent for the rule set. No drift-findings table —
 * the design's own resolution of its open question 8: the plan's
 * `unmatchedObserved` carries the same information `ContainerHostPlan`'s does,
 * and Pangolin's "unexpected" case is the NORM, not the exception.
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
  TAILSCALE_CGNAT_V4_CIDR,
  TAILSCALE_ULA_V6_CIDR,
  isPrivateTailnetAddress,
  tailnetAddressKind,
} from "./tailnet-address.ts";
export type { TailnetAddressKind } from "./tailnet-address.ts";

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
  UpdateProxyConnectionInput,
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
  RECONCILE_CONTAINER_HOST_TASK,
  SYNC_PROXY_RESOURCE_TASK,
  containerHostJobKey,
} from "./tasks.ts";
// SYNC_TOKEN_POLICY_TASK / SYNC_TOKEN_POLICY_RUN_KIND / tokenJobKey are
// re-exported by tasks.ts internally too (so a caller who only imports
// tasks.ts gets the full task-name set), but the package's own public
// surface takes them from tokens.ts, their defining module — see the
// "tokens (milestone 3)" section below, matching how MATERIALIZE_RECORDS_TASK
// and ENSURE_MAIL_DOMAIN_TASK are taken from domains.ts / mail.ts rather than
// from tasks.ts. `RECONCILE_CONTAINER_HOST_TASK`/`containerHostJobKey` above
// are the one deliberate exception — the task name and job-key shape are
// declared in `tasks.ts` itself (loxep-hb7 Milestone C), and
// `container-hosts.ts` imports them FROM here rather than the reverse.
export type {
  EnsureMailDomainPayload,
  MaterializeRecordsPayload,
  PollMailOwnershipPayload,
  ReconcileContainerHostPayload,
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

/* ---------------------------------------- container hosts (loxep-hb7 Milestone C) --- */

export {
  CONTAINER_HOST_EXTERNAL_TYPE,
  CONTAINER_HOST_LINK_PURPOSE,
  CONTAINER_HOST_PROVIDER,
  RECONCILE_CONTAINER_HOST_RUN_KIND,
  containerHostSecretKey,
  createContainerHostsService,
} from "./container-hosts.ts";
export type {
  ContainerHostIntentMetadata,
  ContainerHostSecretPayload,
  ContainerHostSecretReader,
  ContainerHostsService,
  DeclareContainerHostIntentInput,
  DeclareContainerHostIntentResult,
  DeclaredContainerHostTarget,
  ReconcileContainerHostResult,
  TransactionalContainerHostSecretWriter,
} from "./container-hosts.ts";

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

/* ------------------------------------ proxy (Pangolin chain, loxep-acj.2) --- */

export { planProxyResourceOperations } from "./proxy-port.ts";
export type {
  DesiredProxyResource,
  DesiredProxyRule,
  DesiredProxyTarget,
  ObservedProxyResource,
  ObservedProxyRule,
  ObservedProxyTarget,
  ProxyApplyResult,
  ProxyOperation,
  ProxyProviderCapabilities,
  ProxyProviderPort,
  ProxyReadSubject,
  ProxyResourcePayload,
  ProxyResourcePlan,
  ProxyRulePayload,
  ProxyTargetPayload,
} from "./proxy-port.ts";

export {
  PROXY_RESOURCE_SUBJECT_TYPE,
  RECONCILE_PROXY_RESOURCE_RUN_KIND,
  ProxyWritePolicyError,
  createProxyResourcesService,
} from "./proxy.ts";
export type {
  ProxyResourceRow,
  ProxyResourceRuleRow,
  ProxyResourcesService,
  ProxyWriteAuthorizationContext,
  ReconcileProxyResourceResult,
} from "./proxy.ts";

/* ---------------------------- write authorization (Pangolin chain, loxep-acj.3) --- */

export {
  SelfLockoutError,
  WritePolicyError,
  assertWouldNotLockOut,
  assertWritePolicy,
  highestOperationTier,
  proxyOperationTier,
  wouldLockOut,
  writePolicyBlockedStep,
} from "./write-policy.ts";
export type {
  AssertWritePolicyInput,
  LockoutCheckOperatorContext,
  LockoutCheckRule,
  WouldLockOutInput,
  WouldLockOutReason,
  WriteOperationTier,
  WritePolicyBlockedReason,
} from "./write-policy.ts";

/* ------------------------------ dynamic-IP aliases (Pangolin chain, loxep-acj.5) --- */

export {
  IP_ALIAS_REFERENCE_PREFIX,
  materializeProxyRuleValue,
  planIpAliasFanOut,
} from "./ip-aliases.ts";
export type {
  IpAliasFanOutPlan,
  IpAliasFanOutResourceInput,
  IpAliasFanOutRuleAction,
  IpAliasFanOutRuleInput,
  MaterializedProxyRuleValue,
} from "./ip-aliases.ts";
