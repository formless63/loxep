/**
 * Commerce background work (ADR-0003).
 *
 * Three tasks. `commerce.sync-woo-orders` and `commerce.sync-ebay-orders` each
 * run the incremental order sync for a single connection; the provider
 * boundary is dependency-injected in both cases — an adapter factory for
 * WooCommerce, a page-iterator function for eBay — so this module, like every
 * other task module in the repo, contains no provider API code and imports no
 * credential path.
 *
 * `commerce.redact-order-payloads` is the ADR-0021 retention sweep and the
 * package's ONE cron-scheduled task (see `retention.ts`). Its provider seam is
 * injected on the same principle: a map of `object_type` → payload redactor,
 * built by the composition root from each adapter's redaction helper. Unlike
 * the sync pair it is not per-connection and takes no provider call at all —
 * it is a bounded database maintenance pass.
 *
 * The eBay pair is OPTIONAL: `createCommerceTasks` builds it only when the
 * composition root supplies `iterateEbayOrders`, because that seam is a
 * provider function this package deliberately cannot construct itself (see
 * `ebay-sync.ts` for why `@loxep/commerce` takes no eBay dependency).
 *
 * ## Job keys
 *
 * One queued sync per connection per provider,
 * `jobKey = commerce.sync-<provider>-orders:<id>` with the default `replace`
 * mode: re-enqueueing while one is already queued updates it in place instead
 * of stacking a second poll against the same account. That is the whole
 * rate-protection story at the queue level; the adapter's per-connection token
 * bucket handles the rest.
 *
 * ## The SYNC tasks are the ON-DEMAND path, not the scheduled one
 *
 * (The retention sweep below is the exception — it is genuinely cron-driven,
 * because a retention window is a wall-clock fact and not something any
 * monitor target polls.)
 *
 * Scheduled syncs do NOT run through them. `@loxep/app` routes the
 * `woo_orders` and `ebay_orders` monitor targets into the sync services
 * directly from `market.poll-target`, so the dispatcher, the adaptive
 * cadence, and `backoff_until` own scheduled cadence exactly as they do for
 * every other target type (loxep-xh9.7.2, loxep-xh9.2).
 *
 * What remains here is the on-demand entry point: a backfill, a "sync now"
 * action, a script. That is why its failure semantics differ from
 * `market.poll-target`'s and stay as they are — this task is not the terminal
 * step of a dispatcher that owns retry cadence, so a failure IS a job failure
 * with a small Graphile retry budget. Moving it to `recordPollFailure` would
 * make a manual backfill silently push out the schedule of the target it
 * shares a connection with.
 *
 * ## Registration seam
 *
 * `@loxep/app` owns the composition root and this package must not reach into
 * it. {@link createCommerceTasks} therefore returns a plain value —
 * `tasks`, ready for `createTaskRegistry([...commerce.tasks, ...])` — and
 * nothing here starts, connects, or polls anything until a runtime is handed
 * that registry.
 */
import type { LoxepDb } from "@loxep/db";
import type { SettingsService } from "@loxep/domain";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { AnyLoxepTask, LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import { createEbayOrderSync } from "./ebay-sync.ts";
import type {
  EbayOrderPageIterator,
  EbayOrderSyncService,
} from "./ebay-sync.ts";
import { runOrderPayloadRedactionSweep } from "./retention.ts";
import type { OrderPayloadRedactors } from "./retention.ts";
import { createWooOrderSync } from "./sync.ts";
import type { WooAdapterFactory, WooOrderSyncService } from "./sync.ts";

export const SYNC_WOO_ORDERS_TASK_NAME = "commerce.sync-woo-orders";
export const SYNC_EBAY_ORDERS_TASK_NAME = "commerce.sync-ebay-orders";
export const REDACT_ORDER_PAYLOADS_TASK_NAME = "commerce.redact-order-payloads";

/** Daily at 03:17 — off-peak, and off the hour so it shares no tick. */
export const REDACT_ORDER_PAYLOADS_CRON_MATCH = "17 3 * * *";

const syncWooOrdersPayloadSchema = z.object({
  connectionId: z.uuid(),
  /** Page budget for this run; defaults to the connection's config. */
  maxPages: z.number().int().min(1).max(100).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  /** Explicit attribution for orders this run creates. */
  economicEntityId: z.uuid().nullish(),
  correlationId: z.string().optional(),
});

export type SyncWooOrdersTask = LoxepTask<typeof syncWooOrdersPayloadSchema>;

const syncEbayOrdersPayloadSchema = z.object({
  connectionId: z.uuid(),
  maxPages: z.number().int().min(1).max(100).optional(),
  perPage: z.number().int().min(1).max(200).optional(),
  /** Read each shipped order's shipments (one extra provider call each). */
  includeFulfillments: z.boolean().optional(),
  economicEntityId: z.uuid().nullish(),
  correlationId: z.string().optional(),
});

export type SyncEbayOrdersTask = LoxepTask<typeof syncEbayOrdersPayloadSchema>;

const redactOrderPayloadsPayloadSchema = z.object({
  /** Rows read (and at most rewritten) per batch. */
  batchSize: z.number().int().min(1).max(5000).optional(),
  /** Batches this run may execute before deferring the rest. */
  maxBatches: z.number().int().min(1).max(500).optional(),
  correlationId: z.string().optional(),
});

export type RedactOrderPayloadsTask = LoxepTask<
  typeof redactOrderPayloadsPayloadSchema
>;

/**
 * Structural equivalent of graphile-worker's `CronItem` (this package takes no
 * graphile-worker dependency; the object is assignable where the runtime
 * expects a `CronItem`) — same convention as `@loxep/market`'s cron item.
 */
export interface CommerceCronItem {
  task: string;
  match: string;
  identifier: string;
  options: {
    maxAttempts: number;
    backfillPeriod: number;
    jobKey: string;
    jobKeyMode: "replace";
  };
}

export interface CommerceTasks {
  syncWooOrdersTask: SyncWooOrdersTask;
  /** The sync service the task is bound to; exposed for direct invocation. */
  sync: WooOrderSyncService;
  /**
   * The eBay order-sync service and its on-demand task, or null when the
   * composition root supplied no eBay page iterator.
   *
   * Optional rather than required because the seam is a provider function the
   * composition root must bind (see `ebay-sync.ts`), and a caller that has not
   * bound it — a Woo-only test, a partial composition — must still get a valid
   * task list rather than a half-built eBay task that fails at run time.
   */
  ebaySync: EbayOrderSyncService | null;
  syncEbayOrdersTask: SyncEbayOrdersTask | null;
  /**
   * The ADR-0021 retention sweep. Unlike the eBay pair this is NEVER null: the
   * policy it enforces is on by default, so a composition that forgot to
   * inject redactors must still run the job and report what it could not
   * redact rather than silently ship an installation with no retention at all.
   */
  redactOrderPayloadsTask: RedactOrderPayloadsTask;
  /** Cron: once daily; jobKey-replace collapses overlapping ticks. */
  redactOrderPayloadsCronItem: CommerceCronItem;
  /** Ready for `createTaskRegistry([...])`. */
  tasks: readonly AnyLoxepTask[];
}

/** Raw Graphile `addJob` signature, structurally (no graphile-worker dep). */
export type RawAddJob = (
  identifier: string,
  payload?: unknown,
  spec?: {
    jobKey?: string;
    jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
    maxAttempts?: number;
    priority?: number;
    runAt?: Date;
  },
) => Promise<unknown>;

/** The canonical job key for one connection's order sync. */
export function wooOrderSyncJobKey(connectionId: string): string {
  return jobKeyFor(SYNC_WOO_ORDERS_TASK_NAME, connectionId);
}

/** The canonical job key for one connection's eBay order sync. */
export function ebayOrderSyncJobKey(connectionId: string): string {
  return jobKeyFor(SYNC_EBAY_ORDERS_TASK_NAME, connectionId);
}

/** Enqueue (or replace) one connection's eBay order sync. */
export async function enqueueEbayOrderSync(
  addJob: RawAddJob,
  input: {
    connectionId: string;
    maxPages?: number;
    perPage?: number;
    includeFulfillments?: boolean;
    priority?: number;
    runAt?: Date;
  },
): Promise<void> {
  const { connectionId, priority, runAt, ...payload } = input;
  await addJob(
    SYNC_EBAY_ORDERS_TASK_NAME,
    { connectionId, ...payload },
    {
      jobKey: ebayOrderSyncJobKey(connectionId),
      jobKeyMode: "replace",
      ...(priority === undefined ? {} : { priority }),
      ...(runAt === undefined ? {} : { runAt }),
    },
  );
}

/** Enqueue (or replace) one connection's order sync. */
export async function enqueueWooOrderSync(
  addJob: RawAddJob,
  input: {
    connectionId: string;
    maxPages?: number;
    perPage?: number;
    priority?: number;
    runAt?: Date;
  },
): Promise<void> {
  const { connectionId, priority, runAt, ...payload } = input;
  await addJob(
    SYNC_WOO_ORDERS_TASK_NAME,
    { connectionId, ...payload },
    {
      jobKey: wooOrderSyncJobKey(connectionId),
      jobKeyMode: "replace",
      ...(priority === undefined ? {} : { priority }),
      ...(runAt === undefined ? {} : { runAt }),
    },
  );
}

export function createCommerceTasks(options: {
  db: LoxepDb;
  adapterFactory: WooAdapterFactory;
  /** Reuse an already-built sync service. */
  sync?: WooOrderSyncService;
  /**
   * The eBay provider seam — see `ebay-sync.ts`. Omitting it builds a
   * Woo-only composition, which is exactly what a Woo-focused test wants.
   */
  iterateEbayOrders?: EbayOrderPageIterator;
  /** Reuse an already-built eBay sync service. */
  ebaySync?: EbayOrderSyncService;
  /**
   * ADR-0021 redaction seam: `object_type` → the provider's payload redactor.
   * Injected for the same reason `iterateEbayOrders` is — this package must
   * not import an integration package to learn a provider's redacted shape.
   * Omitting it yields a reporting-only sweep (see `retention.ts`).
   */
  orderPayloadRedactors?: OrderPayloadRedactors;
  /** Reuse an existing settings service for the retention policy read. */
  settings?: SettingsService;
}): CommerceTasks {
  const sync =
    options.sync ??
    createWooOrderSync({
      db: options.db,
      adapterFactory: options.adapterFactory,
    });

  const syncWooOrdersTask = defineTask({
    name: SYNC_WOO_ORDERS_TASK_NAME,
    payloadSchema: syncWooOrdersPayloadSchema,
    // A store that is down stays down for a while; three attempts surfaces the
    // failure in health detail without hammering a self-hosted WordPress.
    maxAttempts: 3,
    handler: async (payload, { logger }) => {
      const result = await sync.syncConnection({
        connectionId: payload.connectionId,
        ...(payload.maxPages === undefined ? {} : { maxPages: payload.maxPages }),
        ...(payload.perPage === undefined ? {} : { perPage: payload.perPage }),
        ...(payload.economicEntityId === undefined ||
        payload.economicEntityId === null
          ? {}
          : { economicEntityId: payload.economicEntityId }),
      });
      logger.info(
        {
          connectionId: result.connectionId,
          pages: result.pages,
          ordersSeen: result.ordersSeen,
          created: result.created,
          updated: result.updated,
          unchanged: result.unchanged,
          duplicatesMarked: result.duplicatesMarked,
          currencies: result.currencies,
          nextModifiedAfter: result.nextModifiedAfter?.toISOString() ?? null,
        },
        "woocommerce order sync completed",
      );
      return result;
    },
  });

  const ebaySync =
    options.ebaySync ??
    (options.iterateEbayOrders === undefined
      ? null
      : createEbayOrderSync({
          db: options.db,
          iterateOrders: options.iterateEbayOrders,
        }));

  const syncEbayOrdersTask =
    ebaySync === null
      ? null
      : defineTask({
          name: SYNC_EBAY_ORDERS_TASK_NAME,
          payloadSchema: syncEbayOrdersPayloadSchema,
          // Same reasoning as the Woo task: an on-demand backfill, not the
          // terminal step of a dispatcher that owns retry cadence.
          maxAttempts: 3,
          handler: async (payload, { logger }) => {
            const result = await ebaySync.syncConnection({
              connectionId: payload.connectionId,
              ...(payload.maxPages === undefined
                ? {}
                : { maxPages: payload.maxPages }),
              ...(payload.perPage === undefined
                ? {}
                : { perPage: payload.perPage }),
              ...(payload.includeFulfillments === undefined
                ? {}
                : { includeFulfillments: payload.includeFulfillments }),
              ...(payload.economicEntityId === undefined ||
              payload.economicEntityId === null
                ? {}
                : { economicEntityId: payload.economicEntityId }),
            });
            logger.info(
              {
                connectionId: result.connectionId,
                pages: result.pages,
                ordersSeen: result.ordersSeen,
                created: result.created,
                updated: result.updated,
                unchanged: result.unchanged,
                duplicatesMarked: result.duplicatesMarked,
                currencies: result.currencies,
                unrecognizedStatuses: result.unrecognizedStatuses,
                nextModifiedAfter:
                  result.nextModifiedAfter?.toISOString() ?? null,
              },
              "ebay order sync completed",
            );
            return result;
          },
        });

  const redactOrderPayloadsTask = defineTask({
    name: REDACT_ORDER_PAYLOADS_TASK_NAME,
    payloadSchema: redactOrderPayloadsPayloadSchema,
    // The sweep is idempotent and touches no provider, so a retry is cheap and
    // always safe; three attempts covers a transient database blip without
    // grinding on a genuinely broken policy value (a stored setting that no
    // longer matches its schema throws by design).
    maxAttempts: 3,
    handler: async (payload, { logger }) => {
      const result = await runOrderPayloadRedactionSweep({
        db: options.db,
        ...(options.orderPayloadRedactors === undefined
          ? {}
          : { redactors: options.orderPayloadRedactors }),
        ...(options.settings === undefined
          ? {}
          : { settings: options.settings }),
        ...(payload.batchSize === undefined
          ? {}
          : { batchSize: payload.batchSize }),
        ...(payload.maxBatches === undefined
          ? {}
          : { maxBatches: payload.maxBatches }),
        logger,
      });
      logger.info(
        {
          mode: result.mode,
          afterDays: result.afterDays,
          cutoff: result.cutoff?.toISOString() ?? null,
          scanned: result.scanned,
          redacted: result.redacted,
          alreadyRedacted: result.alreadyRedacted,
          failed: result.failed,
          unhandled: result.unhandled,
          batches: result.batches,
          more: result.more,
        },
        "order payload retention sweep completed",
      );
      return result;
    },
  });

  const redactOrderPayloadsCronItem: CommerceCronItem = {
    task: REDACT_ORDER_PAYLOADS_TASK_NAME,
    match: REDACT_ORDER_PAYLOADS_CRON_MATCH,
    identifier: "commerce_redact_order_payloads",
    options: {
      maxAttempts: redactOrderPayloadsTask.maxAttempts,
      // A missed tick while the worker was down is uninteresting: the next run
      // sweeps everything that has since become eligible, and one extra day of
      // retention on a 180-day window changes nothing.
      backfillPeriod: 0,
      jobKey: jobKeyFor(REDACT_ORDER_PAYLOADS_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return {
    syncWooOrdersTask,
    sync,
    ebaySync,
    syncEbayOrdersTask,
    redactOrderPayloadsTask,
    redactOrderPayloadsCronItem,
    tasks:
      syncEbayOrdersTask === null
        ? [syncWooOrdersTask, redactOrderPayloadsTask]
        : [syncWooOrdersTask, syncEbayOrdersTask, redactOrderPayloadsTask],
  };
}
