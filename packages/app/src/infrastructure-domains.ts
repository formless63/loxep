/**
 * The two managed-domain record tasks — composition-root wiring for the
 * Phase 7 job graph's `materialize-records` → `sync-records` pair
 * (loxep-vdt), and the `reconcile_runs` ownership loxep-vdt deliberately
 * left out (loxep-ejs).
 *
 * ```text
 * infrastructure.materialize-records   intent change   key domain:{id}:materialize
 *      |  (managed_domains / dns_records intent changed, or a mail ownership
 *      |   code arrived)
 *      +→ resolve this domain's Cloudflare adapter (+ Purelymail adapter,
 *         lazily, only if a mail_domains row exists) and bridge each to its
 *         port
 *      +→ @loxep/infrastructure's runMaterializeRecords(...) — THE SERVICE
 *         VERB. Reads every hosting target + its host_addresses (via
 *         wanAddressPair()), the CAA policy, and (lazily) the mail
 *         provider's requiredRecords(); runs materializeDesiredRecords(...);
 *         writes dns_records; enqueues sync-records IN THE SAME
 *         TRANSACTION (zone permitting); and OWNS the whole run's
 *         `reconcile_runs`/`reconcile_run_steps` rows
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
 * ## `materialize-records` is now a THIN WRAPPER (loxep-ejs)
 *
 * Everything that used to live here — assembling the whole
 * `MaterializeInput` from `hosting_targets`/`host_addresses`, the CAA
 * policy, and the mail provider's required-record set, then calling
 * `materializeDesiredRecords`/`applyMaterializedRecords` directly with no
 * `reconcile_runs` row anywhere — has moved into
 * `@loxep/infrastructure`'s `materialize-run.ts` (`runMaterializeRecords`).
 * That module's own doc explains the split in full; the short version is
 * `materialize.ts` must stay pure (no database), `domains.ts` owns intent
 * and the record writer but not run rows, and every OTHER reconciler in
 * this domain (`sync.ts`, `mail-sync.ts`, `container-hosts.ts`) keeps its
 * run machinery in its own module — `materialize-records` was the one
 * exception, and it no longer is.
 *
 * What is left here is exactly what `infrastructure-token.ts` and
 * `infrastructure-mail.ts` already do for their own verbs: resolve the real
 * provider adapters this domain needs (Cloudflare always, Purelymail only
 * when a mail registration exists) and bridge each to the structural port
 * `@loxep/infrastructure` declares, then call the one service entry point.
 * No credential is ever in a job payload — both adapters are resolved
 * INSIDE the task from the domain's stored connections, per `tasks.ts`'s
 * rule 1.
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
 * The one thing a rerun DOES duplicate is the `reconcile_runs` row, which
 * `runMaterializeRecords`'s own doc explains is correct rather than a leak —
 * two runs really did happen.
 *
 * **`sync-records`** inherits `sync.ts`'s own at-least-once contract, quoted
 * from its module doc: the provider read is a read, the diff is pure, apply
 * operations are convergent (the adapter reports a replayed create as
 * `already_present` and a replayed delete as `already_absent`), and findings
 * upsert against the unresolved partial unique.
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
 * domain's apex target. (Both literal strings now live inside
 * `runMaterializeRecords` itself, which is the one place the chained
 * enqueue happens.)
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
 * zone. `runMaterializeRecords` therefore materializes the records (which
 * needs no zone at all — intent is intent) and skips the chained enqueue,
 * recording an `enqueue-sync` step with `errorCode: 'no_provider_zone'`
 * rather than queueing a job that can only burn 25 attempts. `apps/web`'s
 * `requestDomainResync` refuses the same case up front so the operator gets
 * an error instead of a lying success toast.
 *
 * ## `materialize-records` NOW writes a `reconcile_runs` row (loxep-ejs)
 *
 * Before this bead, this module said plainly: "Building one from
 * `@loxep/app` would mean writing `reconcile_run_steps` from the
 * composition root, which is `@loxep/infrastructure`'s job." That is
 * exactly what changed — `runMaterializeRecords` owns the write now, so a
 * `MaterializationError` (a fronting cycle, a tunnel client with no
 * fronting node, a hosting target with no publishable address, a private
 * Tailscale-range address in a `wan`/`operator_declared` row) lands as a
 * FAILED run whose `materialize` step names the exact reason, visible on
 * `/infrastructure/runs` — not just a dead job in the worker log.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  MATERIALIZE_RECORDS_TASK,
  ProviderCallError,
  SYNC_RECORDS_TASK,
  createRecordSyncService,
  createTransactionalEnqueue,
  runMaterializeRecords,
} from "@loxep/infrastructure";
import type {
  MailProviderPort,
  ManagedDomainRow,
  MaterializeRecordsOutcome,
  RecordSyncService,
  RunRecordSyncInput,
} from "@loxep/infrastructure";
import { z } from "zod";
import { AppConfigurationError } from "./errors.ts";
import {
  cloudflareApplyResultRedactor,
  providerPortFromCloudflareAdapter,
} from "./infrastructure-poll-executor.ts";
import { mailProviderPortFromPurelymailAdapter } from "./infrastructure-mail.ts";
import type { AppServices } from "./services.ts";

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
 * Resolve `@loxep/infrastructure`'s `MailProviderPort` for one mail
 * connection, lazily — the resolver `runMaterializeRecords` calls ONLY when
 * the domain has both `mail_enabled` and an existing `mail_domains` row
 * (see `materialize-run.ts`'s own doc for why laziness matters: a
 * credential is decrypted only when there is a required-record set to
 * build).
 */
function resolveMailProvider(
  services: AppServices,
): (mailConnectionId: string) => Promise<Pick<MailProviderPort, "requiredRecords">> {
  return async (mailConnectionId) => {
    const purelymail =
      await services.getPurelymailAdapterForConnection(mailConnectionId);
    return mailProviderPortFromPurelymailAdapter(purelymail.adapter);
  };
}

/**
 * The `infrastructure.materialize-records` body, directly callable.
 *
 * A thin wrapper, matching `infrastructure-token.ts`'s and
 * `infrastructure-mail.ts`'s own shape: resolve the real adapters this
 * domain needs, bridge them to `@loxep/infrastructure`'s structural ports,
 * and call the ONE service verb that owns everything else — the
 * `MaterializeInput` assembly, the pure decision, the desired-record write,
 * the chained enqueue, and the `reconcile_runs`/`reconcile_run_steps` rows.
 */
export async function materializeDomainRecords(
  services: AppServices,
  domainId: string,
): Promise<MaterializeRecordsOutcome> {
  const domain = await requireDomain(services, domainId);
  const cloudflare = await services.getCloudflareAdapterForConnection(
    domain.dnsConnectionId,
  );

  return runMaterializeRecords(domainId, {
    db: services.db,
    dnsProvider: providerPortFromCloudflareAdapter(cloudflare.adapter),
    resolveMailProvider: resolveMailProvider(services),
    enqueue: createTransactionalEnqueue(),
  });
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
          runId: outcome.runId,
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
