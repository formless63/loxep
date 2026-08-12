/**
 * `ebay.refresh-tokens` — the durable half of the eBay token lifecycle
 * (loxep-62y.2).
 *
 * A user access token lives ~2 hours; the refresh token lives ~18 months.
 * Polling alone would refresh lazily (the adapter factory refreshes whatever
 * it finds expiring), but a connection that is not being polled — a paused
 * monitor, an item-only installation — would then drift until its next use.
 * This task keeps every eBay connection's stored credential warm on a
 * schedule, independently of polling.
 *
 * ## Shape
 *
 * One task, two modes, mirroring the market dispatcher:
 *
 * - **dispatch** (`{}`, the cron payload): list `ebay` connections, and for
 *   each one that actually has an `oauth_tokens` credential, enqueue a
 *   per-connection refresh job with `jobKey =
 *   "ebay.refresh-tokens:<connectionId>"` (replace mode). One queued refresh
 *   per connection, ever — overlapping cron ticks collapse.
 * - **refresh** (`{ connectionId }`): resolve the connection's adapter, which
 *   performs `refreshTokenBundleIfNeeded` and persists a refreshed bundle
 *   through the connection-credentials service. Refreshing is therefore
 *   defined in exactly ONE place; this task only decides *when*.
 *
 * A dead refresh token surfaces as the boundary's `auth` kind and is recorded
 * on the connection (`ebay_auth`) — that state is only recoverable by
 * repeating user consent, so it must be visible rather than retried forever.
 */
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import { EbayAdapterError } from "@loxep/integration-ebay";
import { isConnectionArchived } from "@loxep/domain";
import { z } from "zod";
import {
  EBAY_CONNECTION_PROVIDER,
  EBAY_OAUTH_CREDENTIAL_TYPE,
} from "./ebay.ts";
import type { AppServices } from "./services.ts";

export const REFRESH_TOKENS_TASK_NAME = "ebay.refresh-tokens";

/** Loose: cron-scheduled runs carry Graphile's `_cron` envelope field. */
const refreshPayloadSchema = z.looseObject({
  connectionId: z.uuid().optional(),
  correlationId: z.string().optional(),
});

export type RefreshTokensTask = LoxepTask<typeof refreshPayloadSchema>;

/**
 * Structural equivalent of graphile-worker's `CronItem` (this package takes
 * no graphile-worker dependency; the object is assignable where the runtime
 * expects a `CronItem`) — same convention as `@loxep/market`'s cron item.
 */
export interface AppCronItem {
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

/** Every 15 minutes — comfortably inside a 2-hour access-token lifetime. */
export const REFRESH_TOKENS_CRON_MATCH = "*/15 * * * *";

export interface EbayTokenRefreshTasks {
  refreshTokensTask: RefreshTokensTask;
  refreshTokensCronItem: AppCronItem;
}

export function createEbayTokenRefreshTasks(options: {
  services: AppServices;
}): EbayTokenRefreshTasks {
  const { services } = options;

  const refreshTokensTask = defineTask({
    name: REFRESH_TOKENS_TASK_NAME,
    payloadSchema: refreshPayloadSchema,
    // A failed refresh is superseded by the next tick; keep the budget small
    // so a permanently dead refresh token does not churn for hours.
    maxAttempts: 3,
    handler: async (payload, { logger, helpers }) => {
      if (payload.connectionId === undefined) {
        await dispatch(logger, helpers.addJob);
        return;
      }
      await refreshOne(payload.connectionId, logger);
    },
  });

  /** Raw Graphile addJob signature, structurally (no graphile-worker dep). */
  type RawAddJob = (
    identifier: string,
    payload?: unknown,
    spec?: {
      jobKey?: string;
      jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
      maxAttempts?: number;
    },
  ) => Promise<unknown>;

  async function dispatch(
    logger: { info: (obj: object, msg?: string) => void },
    addJob: RawAddJob,
  ): Promise<void> {
    const connections = await services.connections.listConnections({
      provider: EBAY_CONNECTION_PROVIDER,
    });
    let enqueued = 0;
    for (const connection of connections) {
      // `disabled` is the operator's off switch; `archived` is terminal
      // retirement (loxep-o7h). Neither should keep refreshing tokens.
      if (
        connection.status === "disabled" ||
        isConnectionArchived(connection.status)
      ) {
        continue;
      }
      const credentials = await services.connectionCredentials.listCredentials(
        connection.id,
      );
      const hasToken = credentials.some(
        (credential) =>
          credential.credentialType === EBAY_OAUTH_CREDENTIAL_TYPE,
      );
      if (!hasToken) continue;
      await addJob(
        REFRESH_TOKENS_TASK_NAME,
        { connectionId: connection.id },
        {
          // One queued refresh per connection; re-dispatch replaces it.
          jobKey: jobKeyFor(REFRESH_TOKENS_TASK_NAME, connection.id),
          jobKeyMode: "replace",
          maxAttempts: refreshTokensTask.maxAttempts,
        },
      );
      enqueued += 1;
    }
    if (enqueued > 0) {
      logger.info({ connections: enqueued }, "dispatched eBay token refreshes");
    }
  }

  async function refreshOne(
    connectionId: string,
    logger: {
      info: (obj: object, msg?: string) => void;
      error: (obj: object, msg?: string) => void;
    },
  ): Promise<void> {
    // Dropping the cached adapter is what makes this a real refresh: the
    // factory then re-reads the stored credential and runs
    // `refreshTokenBundleIfNeeded` + persistence.
    services.invalidateEbayAdapter(connectionId);
    try {
      const adapter = await services.getEbayAdapterForConnection(connectionId);
      logger.info(
        { connectionId, consented: adapter.user !== null },
        "eBay connection token checked",
      );
      await services.connections.recordConnectionSuccess(connectionId);
    } catch (error) {
      if (error instanceof EbayAdapterError) {
        await services.connections
          .recordConnectionFailure(connectionId, {
            errorCode: `ebay_${error.kind}`,
          })
          .catch(() => undefined);
      }
      logger.error(
        {
          connectionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "eBay token refresh failed",
      );
      throw error;
    }
  }

  const refreshTokensCronItem: AppCronItem = {
    task: REFRESH_TOKENS_TASK_NAME,
    match: REFRESH_TOKENS_CRON_MATCH,
    identifier: "ebay_refresh_tokens",
    options: {
      maxAttempts: refreshTokensTask.maxAttempts,
      // Missed ticks while the worker was down are uninteresting; the next
      // dispatch covers every connection anyway.
      backfillPeriod: 0,
      jobKey: jobKeyFor(REFRESH_TOKENS_TASK_NAME, "cron"),
      jobKeyMode: "replace",
    },
  };

  return { refreshTokensTask, refreshTokensCronItem };
}
