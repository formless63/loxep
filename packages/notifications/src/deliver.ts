/**
 * Delivery pipeline (loxep-ubx.4): the `notifications.deliver` job plus the
 * EXPLICIT detection→delivery bridge.
 *
 * Event detection (@loxep/market `market_events`) and notification delivery
 * stay separate concepts: nothing in event derivation enqueues deliveries.
 * {@link enqueueDeliveriesForEvent} is the single explicit bridge — it
 * matches enabled rules for a detected event and enqueues one
 * `notifications.deliver` job per matched endpoint.
 *
 * ## At-least-once safety
 *
 * Job identity: `jobKey = jobKeyFor("notifications.deliver",
 * "<market_event_id>:<endpoint_id>")` (replace mode). Row identity: the
 * UNIQUE `(market_event_id, endpoint_id)` `notification_deliveries` row is
 * created `pending` with `ON CONFLICT DO NOTHING`, then attempted through
 * the transport. Success stamps `delivered_at`/`provider_message_id`;
 * failure increments `attempt_count`, records `last_error`, marks the row
 * `failed`, and RETHROWS so Graphile retries per policy. Re-running a
 * delivered row is a no-op, so duplicate jobs/retries can never notify
 * twice.
 *
 * Delivery statuses (text + TS union): `pending` → `delivered` | `failed`
 * (a failed row returns to `delivered` when a later attempt succeeds).
 */
import { notificationDeliveries } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import type { SecretsService } from "@loxep/domain";
import { defineTask, jobKeyFor } from "@loxep/jobs";
import type { AddJob, LoxepTask } from "@loxep/jobs";
import { z } from "zod";
import { matchRules, endpointSecretKey } from "./endpoints.ts";
import type { RuleMatchEvent } from "./endpoints.ts";
import { uuidLiteral, textLiteral } from "./sql.ts";
import type {
  NotificationMessage,
  NotificationTransport,
} from "./transport.ts";

export const DELIVER_TASK_NAME = "notifications.deliver";

/** Delivery row statuses (text + TS union, no PG enum). */
export const DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const deliverPayloadSchema = z.object({
  marketEventId: z.uuid(),
  endpointId: z.uuid(),
  correlationId: z.string().optional(),
});

export type DeliverTask = LoxepTask<typeof deliverPayloadSchema>;

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;

/** The market-event fields the pipeline reads (a `market_events` row fits). */
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
   * The explicit detection→delivery bridge: match rules, enqueue one
   * deliver job per distinct matched endpoint. Returns the endpoint ids.
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
  renderMessage?: (event: DeliverableMarketEvent) => NotificationMessage;
}): DeliveryPipeline {
  const { db, secrets, transport } = options;
  const renderMessage = options.renderMessage ?? renderMarketEventMessage;

  const deliverTask: DeliverTask = defineTask({
    name: DELIVER_TASK_NAME,
    payloadSchema: deliverPayloadSchema,
    handler: async (payload, { logger }) => {
      const { marketEventId, endpointId } = payload;

      // Ensure exactly one delivery row per (event, endpoint); at-least-once
      // re-runs land on the existing row.
      await db
        .insert(notificationDeliveries)
        .values({ marketEventId, endpointId, status: "pending" })
        .onConflictDoNothing({
          target: [
            notificationDeliveries.marketEventId,
            notificationDeliveries.endpointId,
          ],
        });
      const delivery = await db.query.notificationDeliveries.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.marketEventId, marketEventId),
            eq(table.endpointId, endpointId),
          ),
      });
      if (delivery === undefined) {
        throw new Error(
          `delivery row for event ${marketEventId} endpoint ${endpointId} missing after ensure`,
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
      const event = await db.query.marketEvents.findFirst({
        where: (table, { eq }) => eq(table.id, marketEventId),
      });
      if (endpoint === undefined || event === undefined) {
        // FKs make this near-impossible; record and stop without retrying.
        await db.execute(
          `update notification_deliveries
              set status = 'failed',
                  last_error = ${textLiteral("endpoint or market event no longer exists")}
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
          message: renderMessage(event),
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
    const rules = await matchRules(db, marketEvent);
    const endpointIds = [...new Set(rules.map((rule) => rule.endpointId))];
    for (const endpointId of endpointIds) {
      await addJob(
        deliverTask,
        { marketEventId: marketEvent.id, endpointId },
        {
          jobKey: jobKeyFor(
            DELIVER_TASK_NAME,
            `${marketEvent.id}:${endpointId}`,
          ),
        },
      );
    }
    return { endpointIds };
  }

  return { deliverTask, enqueueDeliveriesForEvent };
}
