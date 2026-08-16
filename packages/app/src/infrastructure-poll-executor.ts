/**
 * The `infrastructure_domain_reconcile` {@link PollExecutor} — the
 * composition-root wiring loxep-lmy.1 designed but could not ship, because
 * `@loxep/infrastructure`'s manifest did not exist yet (it does now). See
 * `bd show loxep-lmy.1`'s "BLOCKERS AND OWED WORK" for the exact gap this
 * module closes: "the infrastructure executor and the
 * `infrastructure_domain_reconcile` route in `createRoutedPollExecutor`".
 *
 * ```text
 * claimed infrastructure_domain_reconcile target
 *   → market.poll-target
 *   → THIS executor
 *       → find the managed domain pointing BACK at this target
 *         (managed_domains.reconcile_target_id — see monitors.ts's module
 *         doc: "the subject reference points from Infrastructure to the
 *         scheduling row, not the reverse")
 *       → resolve the domain's Cloudflare adapter (cloudflare.ts: token +
 *         account id + per-connection budget), wrapped as a DnsProviderPort
 *       → @loxep/infrastructure createRecordSyncService(...).run(...)   ← the
 *         REAL reconciler: read intent, read observed, diff, record findings
 *       → recordConnectionSuccess
 *   → recordPollSuccess(adaptive facts)            ← next_poll_at advance
 * ```
 *
 * ## Structural mirror of `commerce-ebay.ts`
 *
 * No market observation, no `marketplace_items` row, no `market_events` —
 * exactly like the `ebay_orders`/`woo_orders` branches, and for the same
 * reason: this target type's whole job is to call a REAL sync service and
 * report what it did. `deriveSignals` is `false` for the identical reason
 * those two branches give: a reconcile target links no `monitor_items` and
 * produces no market events, so `collectAdaptiveSignals` would spend a query
 * to be told zero.
 *
 * ## Why this lives in @loxep/app and not in @loxep/infrastructure
 *
 * The design's "Where recurring cadence lives" section states the rule
 * directly: *"The executor belongs to Infrastructure and is wired in the
 * composition root, routed by `target_type` in `@loxep/app`, exactly as the
 * commerce order-sync executors are."* `@loxep/infrastructure` takes no
 * dependency on `@loxep/market` and none on `@loxep/integration-cloudflare`
 * (`port.ts`'s `DnsProviderPort` is re-declared structurally); this module is
 * the one place both meet.
 *
 * ## Mode: drift ('check'), always — apply is an OPERATOR action, not a poll
 *
 * The design's "Where recurring cadence lives" section classifies the work
 * into three kinds and is explicit that only one is scheduling:
 *
 * ```text
 * event-driven   intent changed -> reconcile now        NOT scheduling
 * bounded poll   delegation, ownership verification      NOT scheduling
 * recurring      periodic drift sweep per domain          THIS is scheduling
 * ```
 *
 * ...and "Drift detection" states the recurring sweep's own contract in the
 * same document: *"Drift detection is the same code path with apply
 * disabled — `mode = 'check'`... mode = 'check' record findings only; change
 * nothing at the provider."* Every mention of this target type's cadence in
 * the design ("An hourly sweep across a portfolio of domains...", "the
 * partial unique on unresolved findings is what makes an hourly sweep
 * idempotent") is phrased as a comparison, never as a convergence — an
 * unattended `apply` sweeping every domain in the installation is a
 * materially different risk posture than an unattended `check`, which is
 * exactly why `infraSyncStateSchema.mode` exists as a field an OPERATOR sets
 * for an explicit, future apply trigger (milestone 3's UI / a script), not
 * something this poll reads. This executor therefore hard-codes `'check'`
 * rather than consulting `config.infraSync.mode` — reading it here would
 * make an operator's per-domain preference silently promote a scheduled poll
 * into an unattended `apply` run, which the design never recommends.
 */
import type { PollExecutor, PollOutcome } from "@loxep/market";
import {
  ProviderCallError,
  createRecordSyncService,
} from "@loxep/infrastructure";
import type { DnsProviderPort, ResponseRedactor } from "@loxep/infrastructure";
import type { CloudflareAdapter } from "@loxep/integration-cloudflare";
import { AppConfigurationError } from "./errors.ts";
import type { AppServices } from "./services.ts";

/** The recurring sweep's mode, per the design's "Drift detection" contract. */
export const INFRASTRUCTURE_RECONCILE_POLL_MODE = "check" as const;
/** `reconcile_runs.trigger` this executor always writes. */
export const INFRASTRUCTURE_RECONCILE_POLL_TRIGGER = "poll" as const;

/**
 * Adapt a {@link CloudflareAdapter} to `@loxep/infrastructure`'s
 * `DnsProviderPort`. The two shapes are structurally compatible by design
 * (port.ts's module doc: "re-declared structurally rather than imported"),
 * so this is a thin forward rather than a translation — but it is written as
 * explicit method calls (never destructured) so the adapter's internal
 * `this` binding (`findZoneByName` calls `this.listZones`) survives.
 */
export function providerPortFromCloudflareAdapter(
  adapter: CloudflareAdapter,
): DnsProviderPort {
  return {
    findZoneByName: (name) => adapter.findZoneByName(name),
    read: (subject) => adapter.read(subject),
    apply: (input) => adapter.apply(input),
    capabilities: () => adapter.capabilities(),
  };
}

/**
 * The `reconcile_run_steps` redactor for this adapter. The value handed to a
 * `ResponseRedactor` here is never a raw Cloudflare envelope — `sync.ts`
 * calls it only on an already-normalized {@link DnsApplyResult} (`{kind,
 * type, name, status, externalRecordId}`), which is Loxep-owned and entirely
 * scalar. This is therefore an explicit ALLOW-LIST over that fact rather than
 * a projection of a raw provider response — `@loxep/integration-cloudflare`'s
 * own `redactCloudflareDnsRecord` operates on the raw record shape
 * (`id`/`content`/`ttl`/...) and would be the wrong tool here, silently
 * dropping `status`/`externalRecordId` while adding fields that do not
 * exist on this input. Written locally so the composition root still injects
 * ITS OWN redactor per `sync.ts`'s module doc, rather than falling back to
 * the generic scalar-keeping default.
 */
export const cloudflareApplyResultRedactor: ResponseRedactor = (value) => {
  const record = (value ?? {}) as Record<string, unknown>;
  return {
    kind: typeof record["kind"] === "string" ? record["kind"] : null,
    type: typeof record["type"] === "string" ? record["type"] : null,
    name: typeof record["name"] === "string" ? record["name"] : null,
    status: typeof record["status"] === "string" ? record["status"] : null,
    externalRecordId:
      typeof record["externalRecordId"] === "string"
        ? record["externalRecordId"]
        : null,
  };
};

export interface CreateInfrastructureReconcilePollExecutorOptions {
  services: AppServices;
}

export function createInfrastructureReconcilePollExecutor(
  options: CreateInfrastructureReconcilePollExecutorOptions,
): PollExecutor {
  const { services } = options;
  const db = services.db;

  return async (target, { logger }): Promise<PollOutcome> => {
    if (target.connectionId === null) {
      throw new AppConfigurationError(
        `monitor target ${target.id} (${target.targetType}) has no connection; ` +
          "infrastructure reconcile needs the managed domain's DNS provider connection",
      );
    }
    const connectionId = target.connectionId;

    // The subject reference points from Infrastructure to the scheduling
    // row, not the reverse (monitors.ts's module doc) — so the domain is
    // found by its `reconcile_target_id` FK, never from `target.config`.
    // The relational query API (rather than `drizzle-orm`'s `eq` directly)
    // keeps this module free of a `drizzle-orm` import @loxep/app's own
    // manifest does not declare.
    const domain = await db.query.managedDomains.findFirst({
      where: (table, { eq }) => eq(table.reconcileTargetId, target.id),
    });
    if (domain === undefined) {
      throw new AppConfigurationError(
        `monitor target ${target.id} has no managed domain whose ` +
          "reconcile_target_id points back at it",
      );
    }

    // Resolved BEFORE the sync so a misconfigured connection (no token, no
    // 'cloudflare_credentials' bundle) fails the poll without the sync
    // service constructing anything, and so the rate-budget floor is known
    // even for a run that finds nothing.
    const cloudflare = await services.getCloudflareAdapterForConnection(connectionId);
    const sync = createRecordSyncService({
      db,
      provider: providerPortFromCloudflareAdapter(cloudflare.adapter),
      // Write-authorization gate (Pangolin chain design M3, loxep-acj.3):
      // this connection's stored policy defaults to read_only, so an apply
      // is refused (recorded as a 'blocked' step) until an admin flips it.
      connectionId,
    });

    try {
      const result = await sync.run({
        domainId: domain.id,
        mode: INFRASTRUCTURE_RECONCILE_POLL_MODE,
        trigger: INFRASTRUCTURE_RECONCILE_POLL_TRIGGER,
        redact: cloudflareApplyResultRedactor,
      });
      await services.connections.recordConnectionSuccess(connectionId);

      const compared =
        result.diff.missing.length +
        result.diff.modified.length +
        result.diff.unexpected.length +
        result.diff.unchanged.length;

      logger.info(
        {
          monitorTargetId: target.id,
          domainId: domain.id,
          runId: result.runId,
          status: result.status,
          missing: result.diff.missing.length,
          modified: result.diff.modified.length,
          unexpected: result.diff.unexpected.length,
          unresolvedFindings: result.unresolvedFindings,
          disappearedFindings: result.disappearedFindings,
        },
        "infrastructure domain reconcile poll complete",
      );

      return {
        observations: compared,
        adaptive: {
          // Drift itself is the activity signal, not the mere act of
          // checking — a clean sweep is not "something happened".
          changed: result.unresolvedFindings > 0,
          secondsUntilListingEnd: null,
          recentEventCount: 0,
          recentChangeCount: result.unresolvedFindings,
          bounds: { minSeconds: cloudflare.minIntervalSeconds },
          deriveSignals: false,
        },
      };
    } catch (error) {
      if (error instanceof ProviderCallError) {
        if (error.kind === "auth") {
          // Force a connection + credential re-read on the next poll — the
          // usual cause here is a rotated or revoked API token.
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
  };
}
