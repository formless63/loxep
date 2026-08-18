/**
 * The two managed-domain record tasks — composition-root wiring for the
 * Phase 7 job graph's `materialize-records` → `sync-records` pair
 * (loxep-vdt).
 *
 * ```text
 * infrastructure.materialize-records   intent change   key domain:{id}:materialize
 *      |  (managed_domains / dns_records intent changed, or a mail ownership
 *      |   code arrived)
 *      +→ read the domain, every hosting target + its host_addresses,
 *         the installation CAA policy, the mail provider's required set
 *      +→ materializeDesiredRecords(...)            ← the PURE decision
 *      +→ ManagedDomainsService.applyMaterializedRecords(...)
 *      +→ enqueue sync-records IN THE SAME TRANSACTION (zone permitting)
 *
 * infrastructure.sync-records          after materialize  key domain:{id}:records
 *      +→ resolve the domain's OWN dns connection (managed_domains
 *         .dns_connection_id — never a job payload; Configuration & Secrets
 *         rule 5)
 *      +→ createRecordSyncService(...).run({ mode, trigger })
 * ```
 *
 * ## Why this file exists at all
 *
 * Both task NAMES have been enqueued in production since Phase 7 milestone 1
 * (`domains.ts`'s `create`/`updateIntent`, `mail-sync.ts`'s ownership-code
 * step, and `apps/web`'s "Sync now"/"Retry" buttons), and neither had ever
 * been registered — `git log -S` confirms no handler was lost, only that one
 * was never written. Graphile Worker cannot resolve an unregistered
 * identifier, so every one of those enqueues burned its retry budget and
 * died while the operator saw a success toast. Creating a managed domain
 * therefore never materialized a single DNS record. This module is the
 * missing half.
 *
 * ## Both handlers are idempotent, and here is exactly why
 *
 * Handlers are at-least-once (ADR-0003); a redelivery must be a no-op.
 *
 * **`materialize-records`** is a pure function of stored intent
 * (`materializeDesiredRecords` touches no network and no database) fed into
 * a convergent write: `applyMaterializedRecords` upserts each desired record
 * against `dns_records`' natural key `(domain_id, type, name, content)` —
 * resurrecting a tombstone rather than colliding with it — and soft-deletes
 * only reconciler-owned rows the freshly computed set no longer describes.
 * A second run over unchanged intent computes the same set, updates the same
 * rows to the same values, and soft-deletes nothing: `{created: 0, updated:
 * n, softDeleted: 0}`. `manual`-owned rows are excluded by an `owner <>
 * 'manual'` predicate inside the upsert, not by a filter this module could
 * forget. The `domain:{id}:materialize` job key (default `replace` mode)
 * additionally collapses a burst of intent changes into one pending job.
 *
 * **`sync-records`** inherits `sync.ts`'s own at-least-once contract, quoted
 * from its module doc: the provider read is a read, the diff is pure, apply
 * operations are convergent (the adapter reports a replayed create as
 * `already_present` and a replayed delete as `already_absent`), and findings
 * upsert against the unresolved partial unique. The one thing a rerun DOES
 * duplicate is the `reconcile_runs` row, which is correct rather than a
 * leak — two runs really did happen, and an operator reading
 * `/infrastructure/runs` should see both.
 *
 * ## `mode: 'apply'` after a materialize, and why that is not reckless
 *
 * The chained sync run uses `mode: 'apply'`, `trigger: 'intent_change'` —
 * the SAME shape `container-hosts.ts`'s `declareIntent` already enqueues for
 * `infrastructure.reconcile-container-host`, and for the same reason: an
 * intent change is an operator act, and the design's job graph says
 * `sync-records` follows `materialize-records`. It is not an unattended
 * sweep. The distinction matters because `infrastructure-poll-executor.ts`
 * hard-codes `'check'` and argues at length that a RECURRING apply across
 * every domain in the installation is a materially different risk posture;
 * nothing in that argument applies to a run triggered by a human changing a
 * domain's apex target.
 *
 * It is also gated twice over. `sync.ts` runs `assertWritePolicy` before
 * `provider.apply` with the domain's own `connectionId`, and
 * `infrastructure.provider_write_policy` defaults to `read_only` — so on a
 * fresh installation the apply is REFUSED, recorded as a `'blocked'` step,
 * and the run finishes `'partial'`, fully visible on `/infrastructure/runs`
 * with copy naming the exact flip that unblocks it. DNS apply is therefore
 * reachable end to end, and reaching it still requires an admin to have
 * deliberately raised that connection's tier.
 *
 * ## The zone gate — the one place a chained enqueue is skipped
 *
 * `createRecordSyncService.run()` refuses a domain whose
 * `external_zone_id` is `null` ("has no provider zone yet") and it throws
 * BEFORE inserting its `reconcile_runs` row, so such a run leaves no trace
 * for an operator to read — precisely the invisible-failure shape this bead
 * exists to remove. Today only `provisioning.ts`'s template engine ever sets
 * that column, so a domain created from the plain new-domain form has no
 * zone. `materialize-records` therefore materializes the records (which
 * needs no zone at all — intent is intent) and skips the chained enqueue,
 * logging `syncEnqueued: false` with a reason, rather than queueing a job
 * that can only burn 25 attempts. `apps/web`'s `requestDomainResync` refuses
 * the same case up front so the operator gets an error instead of a lying
 * success toast.
 *
 * ## No credential is ever in a payload, and no `reconcile_runs` row is
 * written here
 *
 * Both payloads carry a `domainId` (plus, for `sync-records`, the two
 * enum-ish scheduling fields the design's own `SyncRecordsPayload` declares)
 * and nothing else. Every credential — the Cloudflare token behind
 * `capabilities()`, the Purelymail token behind `requiredRecords()` — is
 * resolved INSIDE the task from the domain's stored connections, per
 * `tasks.ts`'s rule 1.
 *
 * `materialize-records` writes no `reconcile_runs` row. Building one from
 * `@loxep/app` would mean writing `reconcile_run_steps` from the composition
 * root, which is `@loxep/infrastructure`'s job (`sync.ts`, `mail-sync.ts`,
 * and `container-hosts.ts` each own their own run machinery). The
 * materialize step's outcome is visible as the domain's record list plus the
 * run the chained `sync-records` produces; a materialization FAILURE (a
 * fronting cycle, a target with no publishable address, a tailnet address in
 * a `wan` row) currently surfaces only as a failed job in the worker log,
 * which is a real observability gap recorded here rather than papered over.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  MATERIALIZE_RECORDS_TASK,
  ProviderCallError,
  SYNC_RECORDS_TASK,
  createManagedDomainsService,
  createRecordSyncService,
  createTransactionalEnqueue,
  domainJobKey,
  materializeDesiredRecords,
  wanAddressPair,
} from "@loxep/infrastructure";
import type {
  CaaPolicy,
  DesiredRecord,
  HostingTargetNode,
  ManagedDomainRow,
  MaterializeInput,
  RecordSyncService,
  RunRecordSyncInput,
} from "@loxep/infrastructure";
import { caaPolicySetting } from "@loxep/domain";
import { z } from "zod";
import { AppConfigurationError } from "./errors.ts";
import {
  cloudflareApplyResultRedactor,
  providerPortFromCloudflareAdapter,
} from "./infrastructure-poll-executor.ts";
import type { AppServices } from "./services.ts";

/** The chained sync's mode/trigger — see the module doc's `mode: 'apply'` section. */
export const MATERIALIZE_CHAINED_SYNC_MODE = "apply" as const;
export const MATERIALIZE_CHAINED_SYNC_TRIGGER = "intent_change" as const;

/** Why a materialize run did not chain a `sync-records` job. */
export type MaterializeSyncSkipReason = "no_provider_zone";

export interface MaterializeRecordsOutcome {
  domainId: string;
  desired: readonly DesiredRecord[];
  created: number;
  updated: number;
  softDeleted: number;
  syncEnqueued: boolean;
  syncSkippedReason: MaterializeSyncSkipReason | null;
}

async function requireDomain(
  services: AppServices,
  domainId: string,
): Promise<ManagedDomainRow> {
  const domain = await services.db.query.managedDomains.findFirst({
    where: (table, { eq }) => eq(table.id, domainId),
  });
  if (domain === undefined) {
    throw new AppConfigurationError(
      `managed domain ${domainId} no longer exists; nothing to reconcile`,
    );
  }
  return domain;
}

/**
 * Build the pure materializer's whole input from the database.
 *
 * Exported so a test (and any future preview surface) can see exactly what
 * intent would produce without writing a row. Two of the four inputs deserve
 * a note:
 *
 * - **targets** is EVERY hosting target, not just the apex one, because
 *   `resolveHostingAddress` walks `fronted_by_target_id` and a chain member
 *   that was not supplied is a `MaterializationError` rather than a silent
 *   fallback to the origin's address. Each target's address pair comes from
 *   `wanAddressPair()` — loxep-bub's structural quarantine, the ONE filter
 *   that decides which `host_addresses` row may ever be published.
 * - **mailRecords** is `null` unless the domain has a `mail_domains`
 *   registration; the adapter tolerates a `null` ownership code and returns
 *   six of its seven records, which is deliberate (see
 *   `@loxep/integration-purelymail`'s `records.ts`: publish what you can
 *   now, add the ownership TXT on the next materialize).
 */
export async function buildMaterializeInput(
  services: AppServices,
  domain: ManagedDomainRow,
): Promise<MaterializeInput> {
  const db = services.db;

  const [targetRows, addressRows] = await Promise.all([
    db.query.hostingTargets.findMany(),
    db.query.hostAddresses.findMany(),
  ]);

  const addressesByTarget = new Map<string, typeof addressRows>();
  for (const address of addressRows) {
    const list = addressesByTarget.get(address.hostingTargetId) ?? [];
    list.push(address);
    addressesByTarget.set(address.hostingTargetId, list);
  }

  const targets = new Map<string, HostingTargetNode>();
  for (const target of targetRows) {
    const wan = wanAddressPair(addressesByTarget.get(target.id) ?? []);
    targets.set(target.id, {
      id: target.id,
      name: target.name,
      controlSurface: target.controlSurface as HostingTargetNode["controlSurface"],
      addressV4: wan.addressV4,
      addressV6: wan.addressV6,
      frontedByTargetId: target.frontedByTargetId,
    });
  }

  const caaPolicy: CaaPolicy = await services.settings.get(caaPolicySetting);

  let mailRecords: MaterializeInput["mailRecords"] = null;
  if (domain.mailEnabled) {
    const mail = await db.query.mailDomains.findFirst({
      where: (table, { eq }) => eq(table.domainId, domain.id),
    });
    if (mail !== undefined) {
      const purelymail = await services.getPurelymailAdapterForConnection(
        mail.mailConnectionId,
      );
      mailRecords = purelymail.adapter.requiredRecords({
        domainName: domain.name,
        ownershipCode: mail.ownershipCode,
      });
    }
  }

  // The provider's capabilities gate proxying intent, and getting them wrong
  // degrades silently, so they come from the REAL adapter for this domain's
  // own DNS connection rather than a constant. Building the adapter costs a
  // credential decrypt and no network call — `capabilities()` is local.
  const cloudflare = await services.getCloudflareAdapterForConnection(
    domain.dnsConnectionId,
  );
  const capabilities = cloudflare.adapter.capabilities();

  return {
    domain: {
      name: domain.name,
      apexTargetId: domain.apexTargetId,
      apexProxied: domain.apexProxied,
      wildcardProxied: domain.wildcardProxied,
      mailEnabled: domain.mailEnabled,
    },
    targets,
    caaPolicy,
    mailRecords,
    capabilities: {
      proxying: capabilities.proxying,
      proxiedWildcards: capabilities.proxiedWildcards,
      proxiableTypes: capabilities.proxiableTypes,
    },
  };
}

/**
 * The `infrastructure.materialize-records` body, directly callable.
 *
 * The write and the chained enqueue share ONE transaction, which is the
 * property `domains.ts`'s module doc calls "the whole point": there is no
 * outbox and no "the records changed but the sync never fired" window.
 */
export async function materializeDomainRecords(
  services: AppServices,
  domainId: string,
): Promise<MaterializeRecordsOutcome> {
  const domain = await requireDomain(services, domainId);
  const input = await buildMaterializeInput(services, domain);
  const desired = materializeDesiredRecords(input);

  const domains = createManagedDomainsService({ db: services.db });
  const enqueue = createTransactionalEnqueue();
  const hasZone = domain.externalZoneId !== null;

  const applied = await services.db.transaction(async (tx) => {
    const counts = await domains.applyMaterializedRecords(domain.id, desired, {
      executor: tx,
    });
    if (hasZone) {
      await enqueue(
        tx,
        SYNC_RECORDS_TASK,
        {
          domainId: domain.id,
          mode: MATERIALIZE_CHAINED_SYNC_MODE,
          trigger: MATERIALIZE_CHAINED_SYNC_TRIGGER,
        },
        { jobKey: domainJobKey(SYNC_RECORDS_TASK, domain.id) },
      );
    }
    return counts;
  });

  return {
    domainId: domain.id,
    desired,
    created: applied.created,
    updated: applied.updated,
    softDeleted: applied.softDeleted,
    syncEnqueued: hasZone,
    syncSkippedReason: hasZone ? null : "no_provider_zone",
  };
}

/**
 * Build the record-sync service for one managed domain, resolving the DNS
 * connection from `managed_domains.dns_connection_id` — the same discipline
 * `createMailSyncForDomain` applies to `mail_domains.mail_connection_id`,
 * and the reason neither payload carries a connection id.
 *
 * `connectionId` is passed so `sync.ts`'s write-authorization gate is ARMED.
 * Omitting it would skip the gate entirely (its backward-compatible default
 * for direct construction) and let an unattended job publish DNS against a
 * connection an admin has declared read-only.
 */
export async function createRecordSyncForDomain(
  services: AppServices,
  domain: ManagedDomainRow,
): Promise<RecordSyncService> {
  const cloudflare = await services.getCloudflareAdapterForConnection(
    domain.dnsConnectionId,
  );
  return createRecordSyncService({
    db: services.db,
    provider: providerPortFromCloudflareAdapter(cloudflare.adapter),
    connectionId: domain.dnsConnectionId,
  });
}

const materializePayloadSchema = z.object({
  domainId: z.string().uuid(),
});

/**
 * `SyncRecordsPayload`'s own shape (`tasks.ts`). Both scheduling fields are
 * optional with SAFE defaults: a payload that somehow arrives without them
 * gets a `check` run, which changes nothing at the provider. Every real
 * enqueue site supplies both.
 */
const syncRecordsPayloadSchema = z.object({
  domainId: z.string().uuid(),
  mode: z.enum(["apply", "check"]).default("check"),
  trigger: z
    .enum(["intent_change", "sweep", "manual", "poll"])
    .default("manual"),
});

export interface InfrastructureDomainTasks {
  materializeRecordsTask: LoxepTask<typeof materializePayloadSchema>;
  syncRecordsTask: LoxepTask<typeof syncRecordsPayloadSchema>;
  tasks: readonly [
    LoxepTask<typeof materializePayloadSchema>,
    LoxepTask<typeof syncRecordsPayloadSchema>,
  ];
}

export function createInfrastructureDomainTasks(options: {
  services: AppServices;
}): InfrastructureDomainTasks {
  const { services } = options;

  const materializeRecordsTask = defineTask({
    name: MATERIALIZE_RECORDS_TASK,
    payloadSchema: materializePayloadSchema,
    handler: async (payload, { logger }) => {
      const outcome = await materializeDomainRecords(services, payload.domainId);
      logger.info(
        {
          domainId: outcome.domainId,
          desired: outcome.desired.length,
          created: outcome.created,
          updated: outcome.updated,
          softDeleted: outcome.softDeleted,
          syncEnqueued: outcome.syncEnqueued,
          syncSkippedReason: outcome.syncSkippedReason,
        },
        "infrastructure domain records materialized",
      );
    },
  });

  const syncRecordsTask = defineTask({
    name: SYNC_RECORDS_TASK,
    payloadSchema: syncRecordsPayloadSchema,
    handler: async (payload, { logger }) => {
      const domain = await requireDomain(services, payload.domainId);
      if (domain.externalZoneId === null) {
        // See the module doc's zone gate. `run()` would throw here BEFORE
        // recording a run row, so retrying 25 times produces nothing an
        // operator can read and nothing a retry could ever fix — only
        // provisioning a zone can. Logged and finished, while the enqueue
        // sites refuse this case up front.
        logger.info(
          { domainId: domain.id, domain: domain.name, state: domain.state },
          "infrastructure record sync skipped: domain has no provider zone yet",
        );
        return;
      }

      const connectionId = domain.dnsConnectionId;
      const sync = await createRecordSyncForDomain(services, domain);
      const input: RunRecordSyncInput = {
        domainId: domain.id,
        mode: payload.mode,
        trigger: payload.trigger,
        redact: cloudflareApplyResultRedactor,
      };

      try {
        const result = await sync.run(input);
        await services.connections.recordConnectionSuccess(connectionId);
        logger.info(
          {
            domainId: domain.id,
            runId: result.runId,
            status: result.status,
            mode: result.mode,
            trigger: payload.trigger,
            applied: result.applied,
            missing: result.diff.missing.length,
            modified: result.diff.modified.length,
            unexpected: result.diff.unexpected.length,
            unresolvedFindings: result.unresolvedFindings,
            // Non-null means an admin still has to raise this connection's
            // write policy; the run row says the same thing on-screen.
            writePolicyBlockedReason: result.writePolicyBlockedReason,
          },
          "infrastructure domain record sync complete",
        );
      } catch (error) {
        // The identical provider-failure contract `infrastructure-poll-
        // executor.ts` implements for the recurring sweep: an `auth` failure
        // drops the cached adapter so a rotated token recovers next time,
        // and every provider-class failure lands on connection health.
        if (error instanceof ProviderCallError) {
          if (error.kind === "auth") {
            services.invalidateCloudflareAdapter(connectionId);
          }
          await services.connections
            .recordConnectionFailure(connectionId, {
              errorCode: `cloudflare_${error.kind}`,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
  });

  return {
    materializeRecordsTask,
    syncRecordsTask,
    tasks: [materializeRecordsTask, syncRecordsTask],
  };
}
