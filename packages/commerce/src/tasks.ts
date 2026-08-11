/**
 * Commerce background work (ADR-0003).
 *
 * One task: `commerce.sync-woo-orders`, which runs the incremental order sync
 * for a single connection. The provider adapter is dependency-injected, so
 * this module — like every other task module in the repo — contains no
 * provider API code and imports no credential path.
 *
 * ## Job keys
 *
 * One queued sync per connection, `jobKey = commerce.sync-woo-orders:<id>`
 * with the default `replace` mode: re-enqueueing while one is already queued
 * updates it in place instead of stacking a second poll against the same
 * store. That is the whole rate-protection story at the queue level; the
 * adapter's per-connection token bucket handles the rest.
 *
 * ## Failure semantics
 *
 * A sync failure is a JOB failure here, not silently swallowed domain state —
 * unlike `market.poll-target`, this task is not (yet) the terminal step of a
 * dispatcher that owns retry cadence through `backoff_until`. Once the
 * app-side executor routes `woo_orders` monitor targets into this service (see
 * the registration bead), the failure path should move to
 * `recordPollFailure`, and the retry budget here should drop to 1 for the
 * same reason `market.poll-target` uses 1.
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
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import { createWooOrderSync } from "./sync.ts";
import type { WooAdapterFactory, WooOrderSyncService } from "./sync.ts";

export const SYNC_WOO_ORDERS_TASK_NAME = "commerce.sync-woo-orders";

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

export interface CommerceTasks {
  syncWooOrdersTask: SyncWooOrdersTask;
  /** The sync service the task is bound to; exposed for direct invocation. */
  sync: WooOrderSyncService;
  /** Ready for `createTaskRegistry([...])`. */
  tasks: readonly [SyncWooOrdersTask];
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

  return {
    syncWooOrdersTask,
    sync,
    tasks: [syncWooOrdersTask],
  };
}
