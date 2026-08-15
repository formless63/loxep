/**
 * Recording a sale for a manual/offline channel listing (design 4a, open
 * question 7, loxep-dgf.6).
 *
 * ## PROVISIONAL (design open question 7)
 *
 * `orders.connection_id` is nullable as of migration 0019, resolved per the
 * design's own recommendation and implemented under the same owner directive
 * as every other PROVISIONAL decision in this package (see the block atop
 * `packages/db/src/schema/commerce.ts`): `connection_id` null,
 * `provider = 'manual'`, `source_account_key = 'manual:<installation>'`
 * ({@link MANUAL_SOURCE_ACCOUNT_KEY} — a self-hosted installation has
 * exactly one manual "account", so a fixed constant IS the value; there is
 * nothing to disambiguate), the same kind/reference `CHECK` 4a puts on
 * `channel_listings`. Before this migration a manual listing could not
 * record its own sale at all — the honesty requirement the design names.
 *
 * This module writes ONLY the Commerce-owned side: the `orders` +
 * `order_lines` rows, and the listing's `status`/`quantity_available`. It
 * does not touch inventory — depleting the stock unit is
 * `@loxep/inventory`'s `allocationsService.reserve` +
 * `.depleteOnFulfillment`, a cross-package write `@loxep/commerce`
 * deliberately does not reach into (this package takes no dependency on
 * `@loxep/inventory` — see the design's package-ownership table). The two
 * calls are composed by whichever caller already sits above both packages
 * (the `apps/web` server-function orchestration pattern
 * `createAcquisitionFromMarketItem` already established for exactly this
 * shape of cross-package write).
 */
import { randomUUID } from "node:crypto";
import type { LoxepDb } from "@loxep/db";
import { orderLines, orders } from "@loxep/db/schema";
import { MANUAL_PROVIDER } from "@loxep/db/schema";
import { publishNotificationEvent } from "@loxep/domain";
import type { NotificationEnqueue } from "@loxep/domain";
import { z } from "zod";
import { multiplyDecimals, toMoneyString } from "./decimal.ts";
import {
  CommerceConflictError,
  CommerceNotFoundError,
  CommerceValidationError,
} from "./errors.ts";
import { nullable, textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

type Tx = Parameters<Parameters<LoxepDb["transaction"]>[0]>[0];

/**
 * A self-hosted Loxep installation has exactly one manual "account" — there
 * is no multi-tenancy to disambiguate (the implementation contract's "no
 * SaaS multi-tenancy" rule) — so this is a fixed constant, not a derived
 * value, and IS the design's `manual:<installation>` shape.
 */
export const MANUAL_SOURCE_ACCOUNT_KEY = "manual:default";

const recordManualSaleSchema = z.strictObject({
  channelListingId: z.uuid(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, "expected a positive decimal quantity")
    .default("1"),
  unitPrice: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, "expected a positive decimal amount"),
  currency: z.string().trim().regex(/^[A-Za-z]{3}$/).optional(),
  economicEntityId: z.uuid().nullish(),
  createdByUserId: z.string().min(1).nullish(),
  occurredAt: z.date().nullish(),
});

export type RecordManualSaleInput = z.input<typeof recordManualSaleSchema>;

export interface RecordManualSaleResult {
  orderId: string;
  orderLineId: string;
  catalogItemId: string;
  channelListingId: string;
  quantity: string;
  /** The channel listing's status after this sale — `'sold_out'` when nothing remains. */
  listingStatus: string;
}

export interface ManualSalesService {
  recordManualSale: (
    input: RecordManualSaleInput,
  ) => Promise<RecordManualSaleResult>;
}

export function createManualSalesService(options: {
  db: LoxepDb;
  /**
   * Notification delivery seam (ADR-0023). Omit and a recorded sale is still
   * RECORDED as a `sale`-class notification event — detection does not depend
   * on delivery — but routed nowhere.
   */
  enqueue?: NotificationEnqueue;
  /** Called when emitting the notification event fails; never rethrown. */
  onNotificationError?: (error: unknown) => void;
}): ManualSalesService {
  const { db } = options;

  async function recordManualSale(
    input: RecordManualSaleInput,
  ): Promise<RecordManualSaleResult> {
    const parsed = recordManualSaleSchema.safeParse(input);
    if (!parsed.success) {
      throw new CommerceValidationError(
        `invalid manual sale: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const value = parsed.data;

    return db.transaction(async (tx: Tx) => {
      const listing = await tx.query.channelListings.findFirst({
        where: (table, { eq }) => eq(table.id, value.channelListingId),
      });
      if (listing === undefined) {
        throw new CommerceNotFoundError(
          `unknown channel listing "${value.channelListingId}"`,
        );
      }
      if (listing.provider !== MANUAL_PROVIDER) {
        throw new CommerceValidationError(
          `channel listing "${listing.listingCode}" is provider ` +
            `"${listing.provider}", not "${MANUAL_PROVIDER}" — a connector-` +
            "synced listing records its sale through the normal order sync, " +
            "never through the manual sale recorder",
        );
      }
      if (listing.status === "sold_out" || listing.status === "ended") {
        throw new CommerceConflictError(
          `channel listing "${listing.listingCode}" is already ` +
            `"${listing.status}" — nothing left to sell`,
        );
      }

      const catalogItem = await tx.query.catalogItems.findFirst({
        where: (table, { eq }) => eq(table.id, listing.catalogItemId),
      });
      if (catalogItem === undefined) {
        throw new CommerceNotFoundError(
          `unknown catalog item "${listing.catalogItemId}"`,
        );
      }

      const currency = (value.currency ?? listing.currency ?? "USD").toUpperCase();
      const unitPrice = toMoneyString(value.unitPrice);
      const lineSubtotal = multiplyDecimals(unitPrice, value.quantity);
      const now = new Date();
      const occurredAt = value.occurredAt ?? now;
      const externalOrderId = `manual:${randomUUID()}`;

      const insertedOrders = await tx
        .insert(orders)
        .values({
          connectionId: null,
          provider: MANUAL_PROVIDER,
          channel: listing.channel,
          marketplace: null,
          sourceAccountKey: MANUAL_SOURCE_ACCOUNT_KEY,
          externalOrderId,
          externalOrderNumber: listing.listingCode,
          economicEntityId: value.economicEntityId ?? null,
          entityAttributionSource:
            value.economicEntityId !== undefined && value.economicEntityId !== null
              ? "manual"
              : "unattributed",
          entityAttributedAt:
            value.economicEntityId !== undefined && value.economicEntityId !== null
              ? now
              : null,
          entityAttributedByUserId:
            value.economicEntityId !== undefined && value.economicEntityId !== null
              ? (value.createdByUserId ?? null)
              : null,
          status: "completed",
          paymentStatus: "paid",
          fulfillmentStatus: "fulfilled",
          providerStatusRaw: null,
          currency,
          subtotalAmount: lineSubtotal,
          totalAmount: lineSubtotal,
          placedAt: occurredAt,
          firstIngestedAt: now,
          lastSyncedAt: now,
        })
        .returning();
      const order = insertedOrders[0];
      if (order === undefined) {
        throw new CommerceNotFoundError("manual order insert returned no row");
      }

      const insertedLines = await tx
        .insert(orderLines)
        .values({
          orderId: order.id,
          lineNumber: 1,
          catalogItemId: catalogItem.id,
          channelListingId: listing.id,
          channelSku: catalogItem.sku,
          title: listing.listingTitle ?? catalogItem.name,
          quantity: value.quantity,
          unitPrice,
          lineSubtotal,
          lineTotal: lineSubtotal,
        })
        .returning();
      const line = insertedLines[0];
      if (line === undefined) {
        throw new CommerceNotFoundError("manual order line insert returned no row");
      }

      const remaining =
        listing.quantityAvailable === null
          ? null
          : Math.max(0, listing.quantityAvailable - Number(value.quantity));
      const listingStatus = remaining === 0 ? "sold_out" : listing.status;

      // Raw SQL, matching `catalog.ts`'s `linkMarketplaceItem`: this package
      // takes no `drizzle-orm` dependency, so the query-builder `.where()`
      // (which needs `eq()` from `drizzle-orm`) is unavailable here.
      await tx.execute(
        `update channel_listings
            set quantity_available = ${remaining === null ? "null" : String(remaining)},
                status = ${textLiteral(listingStatus)},
                ended_at = ${listingStatus === "sold_out" ? timestamptzLiteral(now) : nullable(listing.endedAt, timestamptzLiteral)},
                updated_at = now()
          where id = ${uuidLiteral(listing.id)}`,
      );

      // Detection→delivery bridge (ADR-0023), inside the sale's own
      // transaction so a rolled-back sale takes its notification with it.
      //
      // The emission runs in a SAVEPOINT: PostgreSQL aborts the whole
      // transaction on any statement error, so without one a notification
      // problem would roll back the sale it was reporting on. The sale is the
      // fact that matters; the notification is not.
      try {
        await tx.transaction(async (savepoint: Tx) => {
          await publishNotificationEvent({
            executor: savepoint,
            enqueue: options.enqueue,
            event: {
              eventClass: "sale",
              eventType: "manual_sale_recorded",
              subjectType: "order",
              subjectId: order.id,
              occurredAt: now,
              payload: {
                listingTitle: listing.listingTitle ?? catalogItem.name,
                listingCode: listing.listingCode,
                channelListingId: listing.id,
                catalogItemId: catalogItem.id,
                quantity: value.quantity,
                totalAmount: lineSubtotal,
                currency,
                listingStatus,
              },
              deduplicationKey: `order:${order.id}:manual_sale_recorded`,
            },
          });
        });
      } catch (error) {
        options.onNotificationError?.(error);
      }

      return {
        orderId: order.id,
        orderLineId: line.id,
        catalogItemId: catalogItem.id,
        channelListingId: listing.id,
        quantity: value.quantity,
        listingStatus,
      };
    });
  }

  return { recordManualSale };
}
