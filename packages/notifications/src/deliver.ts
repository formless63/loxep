/**
 * Delivery pipeline (loxep-ubx.4, generalized by loxep-oii / ADR-0023): the
 * `notifications.deliver` job plus the EXPLICIT detection→delivery bridge.
 *
 * Event detection and notification delivery stay separate concepts: nothing in
 * event derivation enqueues deliveries. The detection side records
 * `notification_events` rows (`@loxep/domain`); this module routes them and
 * turns a match into one job per endpoint.
 *
 * ## Two bridges, one ledger
 *
 * {@link DeliveryPipeline.enqueueDeliveriesForEvent} keeps its exact shipped
 * signature for the market path — the poll executors already hold a typed
 * `AddJob` — and now records the `market`-class notification event for the
 * detected `market_events` row before routing it. Every other class emits
 * through `@loxep/domain`'s `publishNotificationEvent` with a transactional
 * enqueue seam, because those call sites are inside domain services that
 * cannot depend on this package.
 *
 * ## At-least-once safety
 *
 * Job identity: `jobKey = jobKeyFor("notifications.deliver",
 * "<notification_event_id>:<endpoint_id>")` (replace mode). Row identity: the
 * UNIQUE `(notification_event_id, endpoint_id)` `notification_deliveries` row
 * is created `pending` with `ON CONFLICT DO NOTHING`, then attempted through
 * the transport. Success stamps `delivered_at`/`provider_message_id`; failure
 * increments `attempt_count`, records `last_error`, marks the row `failed`,
 * and RETHROWS so Graphile retries per policy. Re-running a delivered row is a
 * no-op, so duplicate jobs/retries can never notify twice.
 *
 * Delivery statuses (text + TS union): `pending` → `delivered` | `failed`
 * (a failed row returns to `delivered` when a later attempt succeeds).
 */
import { notificationDeliveries } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import {
  NOTIFICATION_DELIVER_TASK,
  publishNotificationEvent,
} from "@loxep/domain";
import type {
  NotificationEnqueue,
  NotificationEventRow,
  SecretsService,
} from "@loxep/domain";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { AddJob, LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import { endpointSecretKey } from "./endpoints.ts";
import type { RuleMatchEvent } from "./endpoints.ts";
import {
  marketEventFromNotificationEvent,
  renderNotificationEventMessage,
} from "./render.ts";
import { uuidLiteral, textLiteral } from "./sql.ts";
import type {
  NotificationMessage,
  NotificationTransport,
} from "./transport.ts";

/** Re-declared in `@loxep/domain` so the detection side needs no import here. */
export const DELIVER_TASK_NAME = NOTIFICATION_DELIVER_TASK;

/** Delivery row statuses (text + TS union, no PG enum). */
export const DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const deliverPayloadSchema = z.object({
  notificationEventId: z.uuid(),
  endpointId: z.uuid(),
  correlationId: z.string().optional(),
});

export type DeliverTask = LoxepTask<typeof deliverPayloadSchema>;

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;

/**
 * The market-event fields the market renderer reads. A `market_events` row
 * fits, and so does the projection {@link marketEventFromNotificationEvent}
 * rebuilds from a `market`-class notification event.
 */
export interface DeliverableMarketEvent {
  id: string;
  marketplaceItemId: string;
  eventType: string;
  monitorTargetId: string | null;
  toObservedAt: Date;
  payload: unknown;
}

/**
 * Default message rendering: transport-neutral title/body/tags from the
 * event row. Deliberately plain in Phase 0.
 */
export function renderMarketEventMessage(
  event: DeliverableMarketEvent,
): NotificationMessage {
  return {
    title: `Loxep: ${event.eventType.replaceAll("_", " ")}`,
    body:
      `${event.eventType} for marketplace item ${event.marketplaceItemId} ` +
      `at ${event.toObservedAt.toISOString()} ` +
      `payload=${JSON.stringify(event.payload ?? {})}`,
    tags: [event.eventType],
  };
}

export interface DeliveryPipeline {
  deliverTask: DeliverTask;
  /**
   * The explicit detection→delivery bridge for the MARKET class: record the
   * notification event for a detected `market_events` row, match enabled
   * rules, and enqueue one deliver job per distinct matched endpoint. Returns
   * the endpoint ids.
   */
  enqueueDeliveriesForEvent: (
    addJob: AddJob,
    marketEvent: RuleMatchEvent & { id: string },
  ) => Promise<{ endpointIds: string[] }>;
}

/**
 * Build the delivery pipeline bound to a database handle, the secrets
 * service (endpoint tokens), and a {@link NotificationTransport}.
 */
export function createDeliveryPipeline(options: {
  db: LoxepDb;
  secrets: SecretsService;
  transport: NotificationTransport;
  /**
   * Market-class rendering override (the composition root injects listing
   * context here). Every other event class renders through
   * {@link renderNotificationEventMessage}, which needs no join.
   */
  renderMessage?: (event: DeliverableMarketEvent) => NotificationMessage;
}): DeliveryPipeline {
  const { db, secrets, transport } = options;
  const renderMarket = options.renderMessage ?? renderMarketEventMessage;

  function renderFor(event: NotificationEventRow): NotificationMessage {
    return event.eventClass === "market"
      ? renderMarket(marketEventFromNotificationEvent(event))
      : renderNotificationEventMessage(event);
  }

  const deliverTask: DeliverTask = defineTask({
    name: DELIVER_TASK_NAME,
    payloadSchema: deliverPayloadSchema,
    handler: async (payload, { logger }) => {
      const { notificationEventId, endpointId } = payload;

      // Ensure exactly one delivery row per (event, endpoint); at-least-once
      // re-runs land on the existing row.
      await db
        .insert(notificationDeliveries)
        .values({ notificationEventId, endpointId, status: "pending" })
        .onConflictDoNothing({
          target: [
            notificationDeliveries.notificationEventId,
            notificationDeliveries.endpointId,
          ],
        });
      const delivery = await db.query.notificationDeliveries.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.notificationEventId, notificationEventId),
            eq(table.endpointId, endpointId),
          ),
      });
      if (delivery === undefined) {
        throw new Error(
          `delivery row for event ${notificationEventId} endpoint ${endpointId} missing after ensure`,
        );
      }
      if (delivery.deliveredAt !== null) {
        logger.info(
          { deliveryId: delivery.id },
          "delivery already completed; no-op",
        );
        return;
      }

      const endpoint = await db.query.notificationEndpoints.findFirst({
        where: (table, { eq }) => eq(table.id, endpointId),
      });
      const event = await db.query.notificationEvents.findFirst({
        where: (table, { eq }) => eq(table.id, notificationEventId),
      });
      if (endpoint === undefined || event === undefined) {
        // FKs make this near-impossible; record and stop without retrying.
        await db.execute(
          `update notification_deliveries
              set status = 'failed',
                  last_error = ${textLiteral("endpoint or notification event no longer exists")}
            where id = ${uuidLiteral(delivery.id)}`,
        );
        logger.warn(
          { deliveryId: delivery.id },
          "delivery abandoned: endpoint or event missing",
        );
        return;
      }
      if (!endpoint.enabled) {
        // Leave the row pending; re-enabling the endpoint allows a later
        // explicit re-enqueue to complete it.
        logger.info(
          { deliveryId: delivery.id, endpointId },
          "delivery skipped: endpoint disabled",
        );
        return;
      }

      // Attempt accounting happens BEFORE the transport call so a crash
      // mid-send is still visible as an attempt.
      await db.execute(
        `update notification_deliveries
            set attempt_count = attempt_count + 1,
                last_attempt_at = now()
          where id = ${uuidLiteral(delivery.id)}`,
      );

      const token =
        endpoint.secretId === null
          ? null
          : (
              await secrets.getSecretPayload(
                endpointSecretKey(endpointId),
                "token",
              )
            ).payload.token;

      try {
        const result = await transport.send({
          config: endpoint.config,
          token,
          message: renderFor(event),
        });
        const messageIdSql =
          result.providerMessageId === null
            ? "null"
            : textLiteral(result.providerMessageId);
        await db.execute(
          `update notification_deliveries
              set status = 'delivered',
                  delivered_at = now(),
                  provider_message_id = ${messageIdSql},
                  last_error = null
            where id = ${uuidLiteral(delivery.id)}`,
        );
        logger.info(
          { deliveryId: delivery.id, endpointId },
          "notification delivered",
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        await db.execute(
          `update notification_deliveries
              set status = 'failed',
                  last_error = ${textLiteral(message.slice(0, 500))}
            where id = ${uuidLiteral(delivery.id)}`,
        );
        logger.error(
          { deliveryId: delivery.id, endpointId, err: message },
          "notification delivery failed",
        );
        // Rethrow so Graphile retries per policy; the delivered no-op guard
        // keeps the retry at-least-once safe.
        throw error;
      }
    },
  });

  async function enqueueDeliveriesForEvent(
    addJob: AddJob,
    marketEvent: RuleMatchEvent & { id: string },
  ): Promise<{ endpointIds: string[] }> {
    const row = await db.query.marketEvents.findFirst({
      where: (table, { eq }) => eq(table.id, marketEvent.id),
    });
    if (row === undefined) {
      throw new Error(`unknown market event "${marketEvent.id}"`);
    }
    const marketPayload =
      typeof row.payload === "object" &&
      row.payload !== null &&
      !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : {};

    // The typed AddJob owns its own connection, so this seam ignores the
    // executor it is handed — the market bridge was never transactional with
    // the observation write, and deliberately so (a notification failure must
    // not roll back an observation).
    const enqueue: NotificationEnqueue = async (
      _executor,
      _taskName,
      jobPayload,
      enqueueOptions,
    ) => {
      await addJob(
        deliverTask,
        jobPayload as z.input<typeof deliverPayloadSchema>,
        enqueueOptions?.jobKey === undefined
          ? undefined
          : { jobKey: enqueueOptions.jobKey },
      );
    };

    const published = await publishNotificationEvent({
      executor: db,
      enqueue,
      event: {
        eventClass: "market",
        eventType: row.eventType,
        subjectType: "market_event",
        subjectId: row.id,
        monitorTargetId: row.monitorTargetId,
        occurredAt: row.toObservedAt,
        payload: {
          ...marketPayload,
          marketplaceItemId: row.marketplaceItemId,
        },
        deduplicationKey: `market_event:${row.id}`,
      },
    });
    return { endpointIds: published.endpointIds };
  }

  return { deliverTask, enqueueDeliveriesForEvent };
}

/** Kept exported: the job-key convention is part of the delivery contract. */
export function deliveryJobKey(
  notificationEventId: string,
  endpointId: string,
): string {
  return jobKeyFor(
    DELIVER_TASK_NAME,
    `${notificationEventId}:${endpointId}`,
  );
}
