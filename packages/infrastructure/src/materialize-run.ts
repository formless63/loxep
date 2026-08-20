/**
 * `runMaterializeRecords` — the reconcile-run wrapper around the PURE
 * materializer (`materialize.ts`) and the desired-record writer
 * (`domains.ts`'s `applyMaterializedRecords`), recorded step by step in
 * `reconcile_runs` and `reconcile_run_steps` the same way every sibling
 * reconciler in this package does (loxep-ejs — the observability half
 * loxep-vdt deliberately left out; see `@loxep/app`'s
 * `infrastructure-domains.ts` for the "why left out" history).
 *
 * ## Why this is its own module, not a method on `materialize.ts` or `domains.ts`
 *
 * - `materialize.ts`'s own doc is explicit that it "touches no network and no
 *   database" — that purity is what makes `test/materialize.test.ts` cheap to
 *   run exhaustively, and a `reconcile_runs` write does not belong there.
 * - `domains.ts` owns operator INTENT (`create`/`updateIntent`/`attachZone`)
 *   and the desired-record WRITER (`applyMaterializedRecords`); it does not
 *   otherwise touch `reconcile_runs` — `sync.ts`, `mail-sync.ts`, and
 *   `container-hosts.ts` each keep their OWN run machinery in their own
 *   module, and this follows the same split.
 *
 * ## What moved here from `@loxep/app`
 *
 * Before this module existed, `@loxep/app`'s `infrastructure-domains.ts`
 * assembled the WHOLE `MaterializeInput` itself — every hosting target and
 * its `host_addresses` via `wanAddressPair()`, the CAA policy setting, and
 * the mail provider's `requiredRecords()` — then called
 * `materializeDesiredRecords` and `applyMaterializedRecords` directly, with
 * no run row anywhere. That assembly (`buildMaterializeInput` below) moved
 * HERE: every piece it touches (`hosting_targets`, `host_addresses`,
 * `infrastructure.caa_policy`, `mail_domains`) is a plain database read or a
 * `@loxep/domain` settings read, none of it needs an integration package, and
 * the run/step writes need to wrap the assembly itself — a
 * `MaterializationError` while resolving a fronting chain is exactly the
 * failure this bead exists to make visible, so it must happen INSIDE the run
 * this module owns, not before the run starts.
 *
 * The two things that genuinely cannot move here are the provider CALLS
 * behind `DnsProviderPort.capabilities()` and
 * `MailProviderPort.requiredRecords()` — both already structurally
 * re-declared in this package (`port.ts`, `mail-port.ts`), exactly as
 * `sync.ts` and `mail-sync.ts` already take a provider port rather than an
 * adapter. `@loxep/app`'s wrapper now does exactly what
 * `infrastructure-token.ts` and `infrastructure-mail.ts` already do for
 * their own verbs: resolve the real adapters and bridge them through
 * `providerPortFromCloudflareAdapter` / `mailProviderPortFromPurelymailAdapter`,
 * then call this module's one entry point.
 *
 * ## Idempotency
 *
 * Re-running is safe for the reasons `infrastructure-domains.ts` gave before
 * this bead: `materializeDesiredRecords` is a pure function of stored intent,
 * and `applyMaterializedRecords` upserts against `dns_records`' natural key,
 * resurrecting a tombstone rather than colliding with it, and soft-deletes
 * only what the freshly computed set no longer describes. A second run over
 * unchanged intent produces the same desired set, updates the same rows to
 * the same values, and soft-deletes nothing: `{created: 0, updated: n,
 * softDeleted: 0}`. What is NEW here is that a rerun also writes a NEW
 * `reconcile_runs` row — correct, not a leak, per `sync.ts`'s own rule: two
 * runs really did happen, and an operator reading `/infrastructure/runs`
 * should see both.
 *
 * ## Failure: no half-written record set
 *
 * `materializeDesiredRecords` runs strictly BEFORE any `dns_records` write —
 * a `MaterializationError` (a fronting cycle, a tunnel client with no
 * fronting node, a hosting target with no publishable address, a private
 * Tailscale-range address in a `wan`/`operator_declared` row, or a proxying
 * intent the provider cannot honor) is thrown while computing the desired
 * set, so `applyMaterializedRecords` is never called at all. The run is
 * finished `'failed'` with a `materialize` step carrying the exact reason
 * (`errorCode: 'materialization_error'`, `errorDetail` the human-readable
 * message, `responseSummary` the error's structured detail), and
 * `dns_records` is left untouched rather than partially published.
 */
import { eq } from "drizzle-orm";
import type { LoxepDb } from "@loxep/db";
import {
  hostAddresses,
  hostingTargets,
  mailDomains,
  managedDomains,
  reconcileRunSteps,
  reconcileRuns,
} from "@loxep/db/schema";
import { caaPolicySetting, createSettingsService } from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import {
  SYNC_RECORDS_TASK,
  createManagedDomainsService,
  domainJobKey,
} from "./domains.ts";
import type { ManagedDomainRow, TransactionalEnqueue } from "./domains.ts";
import { InfrastructureNotFoundError, MaterializationError } from "./errors.ts";
import { wanAddressPair } from "./host-addresses.ts";
import type { MailProviderPort } from "./mail-port.ts";
import { materializeDesiredRecords } from "./materialize.ts";
import type {
  CaaPolicy,
  DesiredRecord,
  HostingTargetNode,
  MaterializeInput,
} from "./materialize.ts";
import type { DnsProviderPort } from "./port.ts";

/** `reconcile_runs.kind` for this module. */
export const MATERIALIZE_RECORDS_RUN_KIND = "materialize-records";

/** Why a materialize run did not chain a `sync-records` job. */
export type MaterializeSyncSkipReason = "no_provider_zone";

export interface MaterializeRecordsOutcome {
  runId: string;
  domainId: string;
  desired: readonly DesiredRecord[];
  created: number;
  updated: number;
  softDeleted: number;
  syncEnqueued: boolean;
  syncSkippedReason: MaterializeSyncSkipReason | null;
}

export interface RunMaterializeRecordsOptions {
  db: LoxepDb;
  /**
   * Only `.capabilities()` is ever called — this verb never reads or writes
   * DNS records at the provider, only asks what it CAN do.
   */
  dnsProvider: Pick<DnsProviderPort, "capabilities">;
  /**
   * Resolves a mail provider port for a `mail_domains.mail_connection_id`,
   * called ONLY when the domain has both `mail_enabled` and an EXISTING
   * `mail_domains` row — never for a domain that has not registered mail
   * yet, matching `buildMaterializeInput`'s original laziness (a credential
   * is decrypted only when there is a required-record set to build).
   * Omitting it is safe for every domain that has no mail registration; a
   * domain that DOES have one and gets no resolver here fails loudly rather
   * than silently dropping its mail records.
   */
  resolveMailProvider?: (
    mailConnectionId: string,
  ) => Promise<Pick<MailProviderPort, "requiredRecords">>;
  /** Defaults to a no-op enqueue (direct/test construction). */
  enqueue?: TransactionalEnqueue;
  /** Defaults to `createSettingsService({ db })`. */
  settings?: SettingsService;
  actorUserId?: string | null;
  /** Defaults to `'intent_change'` — the only trigger any real caller enqueues today. */
  trigger?: "intent_change" | "sweep" | "manual" | "poll";
}

async function requireDomain(
  db: LoxepDb,
  domainId: string,
): Promise<ManagedDomainRow> {
  const rows = await db
    .select()
    .from(managedDomains)
    .where(eq(managedDomains.id, domainId));
  const row = rows[0];
  if (row === undefined) {
    throw new InfrastructureNotFoundError(
      `managed domain ${domainId} no longer exists; nothing to reconcile`,
      { domainId },
    );
  }
  return row;
}

/**
 * Build the pure materializer's whole input from the database plus the two
 * injected provider ports. Exported so a test (and any future preview
 * surface) can see exactly what intent would produce without writing a row —
 * the same reason `@loxep/app` used to export the equivalent function.
 */
export async function buildMaterializeInput(
  db: LoxepDb,
  domain: ManagedDomainRow,
  options: {
    dnsProvider: Pick<DnsProviderPort, "capabilities">;
    resolveMailProvider?: RunMaterializeRecordsOptions["resolveMailProvider"];
    settings: SettingsService;
  },
): Promise<MaterializeInput> {
  const [targetRows, addressRows] = await Promise.all([
    db.select().from(hostingTargets),
    db.select().from(hostAddresses),
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

  const caaPolicy: CaaPolicy = await options.settings.get(caaPolicySetting);

  let mailRecords: MaterializeInput["mailRecords"] = null;
  if (domain.mailEnabled) {
    const mailRows = await db
      .select()
      .from(mailDomains)
      .where(eq(mailDomains.domainId, domain.id));
    const mail = mailRows[0];
    if (mail !== undefined) {
      if (options.resolveMailProvider === undefined) {
        throw new Error(
          `managed domain "${domain.name}" has a mail registration but materializeRecords was not given a way to resolve its mail provider`,
        );
      }
      const mailProvider = await options.resolveMailProvider(mail.mailConnectionId);
      mailRecords = mailProvider.requiredRecords({
        domainName: domain.name,
        ownershipCode: mail.ownershipCode,
      });
    }
  }

  const capabilities = options.dnsProvider.capabilities();

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
 * The `infrastructure.materialize-records` body, run-recorded.
 *
 * The desired-record write and the chained `sync-records` enqueue share ONE
 * transaction — `infrastructure-domains.ts`'s original "whole point" comment,
 * carried over unchanged: there is no outbox and no "the records changed but
 * the sync never fired" window. The `reconcile_runs`/`reconcile_run_steps`
 * writes are deliberately OUTSIDE that transaction, matching `sync.ts`'s own
 * choice — each step is its own autocommit statement, so a run row and its
 * steps survive to explain a failure even when the substantive write rolls
 * back.
 *
 * Throws on every failure (a `MaterializationError`, a missing mail-provider
 * resolver, or an unexpected error from the transactional write) AFTER
 * recording the failed run — the caller (a Graphile Worker task handler)
 * still gets a rejected promise and normal retry/backoff behavior; what
 * changed is that the failure is no longer invisible outside the worker log.
 */
export async function runMaterializeRecords(
  domainId: string,
  options: RunMaterializeRecordsOptions,
): Promise<MaterializeRecordsOutcome> {
  const { db } = options;
  const settings = options.settings ?? createSettingsService({ db });
  const enqueue: TransactionalEnqueue = options.enqueue ?? (async () => undefined);
  const trigger = options.trigger ?? "intent_change";

  const domain = await requireDomain(db, domainId);

  const runRows = await db
    .insert(reconcileRuns)
    .values({
      kind: MATERIALIZE_RECORDS_RUN_KIND,
      subjectType: "domain",
      subjectId: domain.id,
      mode: "apply",
      trigger,
      actorUserId: options.actorUserId ?? null,
    })
    .returning();
  const run = runRows[0];
  if (run === undefined) throw new Error("reconcile run insert returned no row");

  let sequence = 0;
  const step = async (entry: {
    step: string;
    status: "succeeded" | "failed" | "skipped";
    requestSummary?: Record<string, unknown> | null;
    responseSummary?: Record<string, unknown> | null;
    errorCode?: string | null;
    errorDetail?: string | null;
  }): Promise<void> => {
    await db.insert(reconcileRunSteps).values({
      runId: run.id,
      sequence: sequence++,
      step: entry.step,
      status: entry.status,
      provider: "dns",
      requestSummary: entry.requestSummary ?? null,
      responseSummary: entry.responseSummary ?? null,
      errorCode: entry.errorCode ?? null,
      errorDetail: entry.errorDetail ?? null,
    });
  };

  const finish = async (
    status: "succeeded" | "failed",
    errorSummary: string | null,
  ): Promise<void> => {
    await db
      .update(reconcileRuns)
      .set({ status, finishedAt: new Date(), stepCount: sequence, errorSummary })
      .where(eq(reconcileRuns.id, run.id));
  };

  let input: MaterializeInput;
  try {
    input = await buildMaterializeInput(db, domain, {
      dnsProvider: options.dnsProvider,
      resolveMailProvider: options.resolveMailProvider,
      settings,
    });
    await step({
      step: "read-intent",
      status: "succeeded",
      responseSummary: {
        apexTargetId: domain.apexTargetId,
        mailEnabled: domain.mailEnabled,
        mailRecords: input.mailRecords?.length ?? 0,
        caaReviewed: input.caaPolicy.reviewed,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to read materialize intent";
    await step({ step: "read-intent", status: "failed", errorDetail: message });
    await finish("failed", message);
    throw error;
  }

  let desired: DesiredRecord[];
  try {
    desired = materializeDesiredRecords(input);
  } catch (error) {
    if (error instanceof MaterializationError) {
      await step({
        step: "materialize",
        status: "failed",
        errorCode: "materialization_error",
        errorDetail: error.message,
        responseSummary:
          Object.keys(error.detail).length > 0 ? error.detail : null,
      });
      await finish("failed", error.message);
      throw error;
    }
    const message = error instanceof Error ? error.message : "materialize failed";
    await step({ step: "materialize", status: "failed", errorDetail: message });
    await finish("failed", message);
    throw error;
  }

  await step({
    step: "materialize",
    status: "succeeded",
    responseSummary: { desired: desired.length },
  });

  const domains = createManagedDomainsService({ db });
  const hasZone = domain.externalZoneId !== null;

  let applied: { created: number; updated: number; softDeleted: number };
  try {
    applied = await db.transaction(async (tx) => {
      const counts = await domains.applyMaterializedRecords(domain.id, desired, {
        executor: tx,
      });
      if (hasZone) {
        await enqueue(
          tx,
          SYNC_RECORDS_TASK,
          { domainId: domain.id, mode: "apply", trigger: "intent_change" },
          { jobKey: domainJobKey(SYNC_RECORDS_TASK, domain.id) },
        );
      }
      return counts;
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "apply materialized records failed";
    await step({ step: "apply-records", status: "failed", errorDetail: message });
    await finish("failed", message);
    throw error;
  }

  await step({
    step: "apply-records",
    status: "succeeded",
    responseSummary: { ...applied },
  });

  await step(
    hasZone
      ? {
          step: "enqueue-sync",
          status: "succeeded",
          responseSummary: { enqueued: true },
        }
      : {
          step: "enqueue-sync",
          status: "skipped",
          errorCode: "no_provider_zone",
          responseSummary: { enqueued: false },
        },
  );

  await finish("succeeded", null);

  return {
    runId: run.id,
    domainId: domain.id,
    desired,
    created: applied.created,
    updated: applied.updated,
    softDeleted: applied.softDeleted,
    syncEnqueued: hasZone,
    syncSkippedReason: hasZone ? null : "no_provider_zone",
  };
}
