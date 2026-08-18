/**
 * Server functions for `/commerce/orders` — the orders LIST and DETAIL
 * surface (loxep-i51, WEAVE AUDIT 2026-08 finding 7).
 *
 * Woo/eBay/Medusa order ingestion has written `orders`, `order_lines`,
 * `order_fees`, `order_refunds`(`_lines`), and `order_fulfillments`(`_lines`)
 * since Phase 3 landed, but until this file every one of those rows was
 * visible only as a dashboard aggregate. This is a READ-ONLY surface over
 * data ingestion already writes — no migration, no new write path, nothing
 * under `packages/` touched.
 *
 * NEW MODULE rather than an addition to `commerce-functions.ts`: that file
 * (590 lines) is a WRITE-heavy concern — manual channel listings and manual
 * sale recording, duplicating `@loxep/commerce`'s untaken service layer
 * pending a `apps/web/package.json` dependency add (see its own header for
 * why). Orders here is read-only and has none of that duplication problem,
 * so folding it into that file would mix two unrelated narratives in one
 * already-large file. `order-sync-functions.ts` already established the
 * precedent of a third, separate concern (sync ENABLEMENT) getting its own
 * file rather than growing `commerce-functions.ts`.
 *
 * Role gate: `requireSession` throughout — reading order history is
 * ordinary operator work, exactly like `/commerce/listings` and
 * `/commerce/catalog`, not an administrative action.
 *
 * Reads go straight through `@loxep/db`'s relational query API
 * (`getAdminServices().handle.db.query.<table>`), the same pattern every
 * other read-only `*-functions.ts` file in this directory uses.
 *
 * ADR-0021 (order-payload retention): provider payload METADATA is surfaced
 * from `provider_objects` — object type, retention state (derived from
 * `redacted_at`, never re-derived from the payload), and when it was
 * captured. The payload body (`payload` jsonb) and its hash
 * (`payload_hash`) are never selected in this file — every
 * `providerObjects`/`sourceEvents` read below passes an explicit `columns`
 * allowlist so a future column addition to those tables cannot silently
 * leak into this surface. `orders.buyer_external_id` /
 * `buyer_display_name` are rendered because the schema design deliberately
 * normalized only a channel handle there (an eBay username, never a real
 * name/email/address) — see commerce-schema-design.md's buyer-identity
 * section; nothing beyond those two columns is exposed.
 *
 * No `@loxep/db/schema` table imports below — every read goes through
 * `handle.db.query.<table>` (Drizzle's relational query API, keyed by table
 * name), which needs no table object in scope, unlike
 * `commerce-functions.ts`'s write paths that build `insert()`/`update()`
 * statements directly against the schema objects.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

const MANUAL_PROVIDER = 'manual';

// ---------------------------------------------------------------------------
// Reads — order list
// ---------------------------------------------------------------------------

export interface OrderListItemDto {
  id: string;
  provider: string;
  isManual: boolean;
  channel: string;
  marketplace: string | null;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  totalAmount: string;
  buyerDisplayName: string | null;
  placedAt: string;
  economicEntityId: string | null;
  entityAttributionSource: string;
}

const orderFilterInput = z.strictObject({
  provider: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional()
});

/**
 * Hundreds to thousands of rows per month per the schema design's own
 * volume estimate, not millions — an unbounded (well past any realistic
 * install size), unpaginated fetch is the documented legitimate exception
 * for honest client-side sort/filter (Frontend Standards, "Tables").
 */
const ORDER_LIST_LIMIT = 5000;

/**
 * Cross-connection duplicates (`duplicate_of_order_id is not null`) are
 * excluded, matching the schema design's own "cross-channel orders" read
 * model — a duplicate is evidence retained for diagnosis, not a second
 * sale, and showing it in the primary list would double-count revenue at a
 * glance. The row itself is never deleted; `fetchOrder` below can still
 * load one directly by id.
 */
export const fetchOrders = createServerFn({ method: 'GET' })
  .inputValidator(orderFilterInput)
  .handler(async ({ data }): Promise<OrderListItemDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const rows = await handle.db.query.orders.findMany({
      where: (table, { and, eq, isNull }) => {
        const clauses = [isNull(table.duplicateOfOrderId)];
        if (data.provider !== undefined) clauses.push(eq(table.provider, data.provider));
        if (data.status !== undefined) clauses.push(eq(table.status, data.status));
        return and(...clauses);
      },
      orderBy: (table, { desc }) => [desc(table.placedAt)],
      limit: ORDER_LIST_LIMIT
    });

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      isManual: row.provider === MANUAL_PROVIDER,
      channel: row.channel,
      marketplace: row.marketplace,
      externalOrderId: row.externalOrderId,
      externalOrderNumber: row.externalOrderNumber,
      status: row.status,
      paymentStatus: row.paymentStatus,
      fulfillmentStatus: row.fulfillmentStatus,
      currency: row.currency,
      totalAmount: row.totalAmount,
      buyerDisplayName: row.buyerDisplayName,
      placedAt: iso(row.placedAt),
      economicEntityId: row.economicEntityId,
      entityAttributionSource: row.entityAttributionSource
    }));
  });

// ---------------------------------------------------------------------------
// Reads — order detail
// ---------------------------------------------------------------------------

export interface OrderLineDto {
  id: string;
  lineNumber: number;
  externalLineId: string | null;
  channelSku: string | null;
  title: string | null;
  quantity: string;
  unitPrice: string;
  lineSubtotal: string;
  discountAmount: string;
  taxAmount: string;
  shippingAmount: string;
  refundedAmount: string;
  lineTotal: string;
  /** Opportunistic joins (design: "none of them may ever be a precondition for ingesting the line"). Absent means exactly that — no match yet, never rendered as a broken link. */
  catalogItemId: string | null;
  catalogItemSku: string | null;
  catalogItemName: string | null;
  channelListingId: string | null;
  channelListingCode: string | null;
  marketplaceItemId: string | null;
  marketplaceItemTitle: string | null;
}

export interface OrderFeeDto {
  id: string;
  orderLineId: string | null;
  feeScope: string;
  feeDirection: string;
  feeType: string;
  providerFeeCode: string | null;
  description: string | null;
  currency: string;
  amount: string;
  chargedAt: string | null;
}

export interface OrderRefundLineDto {
  id: string;
  orderLineId: string | null;
  quantity: string | null;
  amount: string;
}

export interface OrderRefundDto {
  id: string;
  externalRefundId: string | null;
  kind: string;
  status: string;
  reasonCode: string | null;
  currency: string;
  amount: string;
  refundedAt: string | null;
  lines: OrderRefundLineDto[];
}

export interface OrderFulfillmentLineDto {
  orderLineId: string;
  quantity: string;
}

export interface OrderFulfillmentDto {
  id: string;
  externalFulfillmentId: string | null;
  status: string;
  carrierCode: string | null;
  carrierName: string | null;
  serviceCode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  destinationCountry: string | null;
  destinationRegion: string | null;
  lines: OrderFulfillmentLineDto[];
}

/**
 * Retained provider payload METADATA only (ADR-0021). Never the payload
 * body and never its hash — `objectType`, `retention` (derived from
 * `redacted_at`), and `capturedAt` are the only facts this surface exposes
 * about a `provider_objects` snapshot. `sourceKind: 'source_event'` links
 * carry no retention concept (that table has no redaction sweep — ADR-0021
 * scopes the sweep to order-class `provider_objects` rows only).
 */
export interface OrderProvenanceDto {
  linkId: string;
  effect: string;
  linkedAt: string;
  sourceKind: 'provider_object' | 'source_event';
  objectType: string | null;
  capturedAt: string | null;
  retention: 'retained' | 'redacted' | null;
}

export interface OrderDetailDto {
  id: string;
  provider: string;
  isManual: boolean;
  channel: string;
  marketplace: string | null;
  sourceAccountKey: string;
  externalOrderId: string;
  externalOrderNumber: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  providerStatusRaw: string | null;
  currency: string;
  subtotalAmount: string;
  shippingAmount: string;
  discountAmount: string;
  taxAmount: string;
  feeAmount: string;
  refundedAmount: string;
  totalAmount: string;
  buyerExternalId: string | null;
  buyerDisplayName: string | null;
  placedAt: string;
  providerUpdatedAt: string | null;
  /** `orders.last_synced_at` — Loxep's own fetch watermark, distinct from `providerUpdatedAt` (the provider's watermark) — see `order-detail.tsx`'s "Provider updated"/"Last synced" split (loxep-egl). */
  lastSyncedAt: string;
  cancelledAt: string | null;
  economicEntityId: string | null;
  economicEntityName: string | null;
  entityAttributionSource: string;
  entityAttributedAt: string | null;
  duplicateOfOrderId: string | null;
  lines: OrderLineDto[];
  fees: OrderFeeDto[];
  refunds: OrderRefundDto[];
  fulfillments: OrderFulfillmentDto[];
  provenance: OrderProvenanceDto[];
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const list = map.get(key(row));
    if (list) list.push(row);
    else map.set(key(row), [row]);
  }
  return map;
}

export const fetchOrder = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ id: z.uuid() }))
  .handler(async ({ data }): Promise<OrderDetailDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const order = await handle.db.query.orders.findFirst({
      where: (table, { eq }) => eq(table.id, data.id)
    });
    if (order === undefined) {
      throw new Error(`order "${data.id}" not found`);
    }

    const [lineRows, feeRows, refundRows, fulfillmentRows, linkRows] = await Promise.all([
      handle.db.query.orderLines.findMany({
        where: (table, { eq }) => eq(table.orderId, order.id),
        orderBy: (table, { asc }) => [asc(table.lineNumber)]
      }),
      handle.db.query.orderFees.findMany({
        where: (table, { eq }) => eq(table.orderId, order.id)
      }),
      handle.db.query.orderRefunds.findMany({
        where: (table, { eq }) => eq(table.orderId, order.id),
        orderBy: (table, { desc }) => [desc(table.createdAt)]
      }),
      handle.db.query.orderFulfillments.findMany({
        where: (table, { eq }) => eq(table.orderId, order.id)
      }),
      handle.db.query.orderSourceLinks.findMany({
        where: (table, { eq }) => eq(table.orderId, order.id),
        orderBy: (table, { desc }) => [desc(table.linkedAt)]
      })
    ]);

    const catalogItemIds = [
      ...new Set(
        lineRows.map((line) => line.catalogItemId).filter((id): id is string => id !== null)
      )
    ];
    const channelListingIds = [
      ...new Set(
        lineRows.map((line) => line.channelListingId).filter((id): id is string => id !== null)
      )
    ];
    const marketplaceItemIds = [
      ...new Set(
        lineRows.map((line) => line.marketplaceItemId).filter((id): id is string => id !== null)
      )
    ];
    const refundIds = refundRows.map((refund) => refund.id);
    const fulfillmentIds = fulfillmentRows.map((fulfillment) => fulfillment.id);
    const sourceEventIds = [
      ...new Set(
        linkRows.map((link) => link.sourceEventId).filter((id): id is string => id !== null)
      )
    ];
    const providerObjectIds = [
      ...new Set(
        linkRows.map((link) => link.providerObjectId).filter((id): id is string => id !== null)
      )
    ];

    const [
      catalogItemRows,
      channelListingRows,
      marketplaceItemRows,
      refundLineRows,
      fulfillmentLineRows,
      sourceEventRows,
      providerObjectRows,
      economicEntityRow
    ] = await Promise.all([
      catalogItemIds.length > 0
        ? handle.db.query.catalogItems.findMany({
            where: (table, { inArray }) => inArray(table.id, catalogItemIds),
            columns: { id: true, sku: true, name: true }
          })
        : [],
      channelListingIds.length > 0
        ? handle.db.query.channelListings.findMany({
            where: (table, { inArray }) => inArray(table.id, channelListingIds),
            columns: { id: true, listingCode: true }
          })
        : [],
      marketplaceItemIds.length > 0
        ? handle.db.query.marketplaceItems.findMany({
            where: (table, { inArray }) => inArray(table.id, marketplaceItemIds),
            columns: { id: true, title: true }
          })
        : [],
      refundIds.length > 0
        ? handle.db.query.orderRefundLines.findMany({
            where: (table, { inArray }) => inArray(table.orderRefundId, refundIds)
          })
        : [],
      fulfillmentIds.length > 0
        ? handle.db.query.orderFulfillmentLines.findMany({
            where: (table, { inArray }) => inArray(table.orderFulfillmentId, fulfillmentIds)
          })
        : [],
      // Metadata only — no `payload`/`payloadHash` column in this allowlist.
      sourceEventIds.length > 0
        ? handle.db.query.sourceEvents.findMany({
            where: (table, { inArray }) => inArray(table.id, sourceEventIds),
            columns: { id: true, eventType: true, receivedAt: true }
          })
        : [],
      // Metadata only (ADR-0021) — object type, capture time, redaction
      // state. No `payload`/`payloadHash` column in this allowlist.
      providerObjectIds.length > 0
        ? handle.db.query.providerObjects.findMany({
            where: (table, { inArray }) => inArray(table.id, providerObjectIds),
            columns: { id: true, objectType: true, fetchedAt: true, redactedAt: true }
          })
        : [],
      order.economicEntityId !== null
        ? handle.db.query.economicEntities.findFirst({
            where: (table, { eq }) => eq(table.id, order.economicEntityId as string),
            columns: { id: true, name: true }
          })
        : undefined
    ]);

    const catalogItemById = new Map(catalogItemRows.map((row) => [row.id, row]));
    const channelListingById = new Map(channelListingRows.map((row) => [row.id, row]));
    const marketplaceItemById = new Map(marketplaceItemRows.map((row) => [row.id, row]));
    const refundLinesByRefundId = groupBy(refundLineRows, (row) => row.orderRefundId);
    const fulfillmentLinesByFulfillmentId = groupBy(
      fulfillmentLineRows,
      (row) => row.orderFulfillmentId
    );
    const sourceEventById = new Map(sourceEventRows.map((row) => [row.id, row]));
    const providerObjectById = new Map(providerObjectRows.map((row) => [row.id, row]));

    const lines: OrderLineDto[] = lineRows.map((line) => {
      const catalogItem = line.catalogItemId ? catalogItemById.get(line.catalogItemId) : undefined;
      const channelListing = line.channelListingId
        ? channelListingById.get(line.channelListingId)
        : undefined;
      const marketplaceItem = line.marketplaceItemId
        ? marketplaceItemById.get(line.marketplaceItemId)
        : undefined;
      return {
        id: line.id,
        lineNumber: line.lineNumber,
        externalLineId: line.externalLineId,
        channelSku: line.channelSku,
        title: line.title,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineSubtotal: line.lineSubtotal,
        discountAmount: line.discountAmount,
        taxAmount: line.taxAmount,
        shippingAmount: line.shippingAmount,
        refundedAmount: line.refundedAmount,
        lineTotal: line.lineTotal,
        catalogItemId: line.catalogItemId,
        catalogItemSku: catalogItem?.sku ?? null,
        catalogItemName: catalogItem?.name ?? null,
        channelListingId: line.channelListingId,
        channelListingCode: channelListing?.listingCode ?? null,
        marketplaceItemId: line.marketplaceItemId,
        marketplaceItemTitle: marketplaceItem?.title ?? null
      };
    });

    const fees: OrderFeeDto[] = feeRows.map((fee) => ({
      id: fee.id,
      orderLineId: fee.orderLineId,
      feeScope: fee.feeScope,
      feeDirection: fee.feeDirection,
      feeType: fee.feeType,
      providerFeeCode: fee.providerFeeCode,
      description: fee.description,
      currency: fee.currency,
      amount: fee.amount,
      chargedAt: iso(fee.chargedAt)
    }));

    const refunds: OrderRefundDto[] = refundRows.map((refund) => ({
      id: refund.id,
      externalRefundId: refund.externalRefundId,
      kind: refund.kind,
      status: refund.status,
      reasonCode: refund.reasonCode,
      currency: refund.currency,
      amount: refund.amount,
      refundedAt: iso(refund.refundedAt),
      lines: (refundLinesByRefundId.get(refund.id) ?? []).map((line) => ({
        id: line.id,
        orderLineId: line.orderLineId,
        quantity: line.quantity,
        amount: line.amount
      }))
    }));

    const fulfillments: OrderFulfillmentDto[] = fulfillmentRows.map((fulfillment) => ({
      id: fulfillment.id,
      externalFulfillmentId: fulfillment.externalFulfillmentId,
      status: fulfillment.status,
      carrierCode: fulfillment.carrierCode,
      carrierName: fulfillment.carrierName,
      serviceCode: fulfillment.serviceCode,
      trackingNumber: fulfillment.trackingNumber,
      trackingUrl: fulfillment.trackingUrl,
      shippedAt: iso(fulfillment.shippedAt),
      deliveredAt: iso(fulfillment.deliveredAt),
      destinationCountry: fulfillment.destinationCountry,
      destinationRegion: fulfillment.destinationRegion,
      lines: (fulfillmentLinesByFulfillmentId.get(fulfillment.id) ?? []).map((line) => ({
        orderLineId: line.orderLineId,
        quantity: line.quantity
      }))
    }));

    const provenance: OrderProvenanceDto[] = linkRows.map((link) => {
      if (link.providerObjectId !== null) {
        const providerObject = providerObjectById.get(link.providerObjectId);
        return {
          linkId: link.id,
          effect: link.effect,
          linkedAt: iso(link.linkedAt),
          sourceKind: 'provider_object',
          objectType: providerObject?.objectType ?? null,
          capturedAt: providerObject ? iso(providerObject.fetchedAt) : null,
          retention: providerObject ? (providerObject.redactedAt ? 'redacted' : 'retained') : null
        };
      }
      const sourceEvent =
        link.sourceEventId !== null ? sourceEventById.get(link.sourceEventId) : undefined;
      return {
        linkId: link.id,
        effect: link.effect,
        linkedAt: iso(link.linkedAt),
        sourceKind: 'source_event',
        objectType: sourceEvent?.eventType ?? null,
        capturedAt: sourceEvent ? iso(sourceEvent.receivedAt) : null,
        retention: null
      };
    });

    return {
      id: order.id,
      provider: order.provider,
      isManual: order.provider === MANUAL_PROVIDER,
      channel: order.channel,
      marketplace: order.marketplace,
      sourceAccountKey: order.sourceAccountKey,
      externalOrderId: order.externalOrderId,
      externalOrderNumber: order.externalOrderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
      providerStatusRaw: order.providerStatusRaw,
      currency: order.currency,
      subtotalAmount: order.subtotalAmount,
      shippingAmount: order.shippingAmount,
      discountAmount: order.discountAmount,
      taxAmount: order.taxAmount,
      feeAmount: order.feeAmount,
      refundedAmount: order.refundedAmount,
      totalAmount: order.totalAmount,
      buyerExternalId: order.buyerExternalId,
      buyerDisplayName: order.buyerDisplayName,
      placedAt: iso(order.placedAt),
      providerUpdatedAt: iso(order.providerUpdatedAt),
      lastSyncedAt: iso(order.lastSyncedAt),
      cancelledAt: iso(order.cancelledAt),
      economicEntityId: order.economicEntityId,
      economicEntityName: economicEntityRow?.name ?? null,
      entityAttributionSource: order.entityAttributionSource,
      entityAttributedAt: iso(order.entityAttributedAt),
      duplicateOfOrderId: order.duplicateOfOrderId,
      lines,
      fees,
      refunds,
      fulfillments,
      provenance
    };
  });

// ---------------------------------------------------------------------------
// Writes — order attribution + duplicates (loxep-7fs, A22).
//
// `@loxep/commerce`'s `OrderIngestionService.setOrderAttribution`/
// `reattributeOrders`/`findDuplicateOrderCandidates` had zero callers: every
// order's economic entity was whatever resolved at ingest FOREVER, and it
// feeds every downstream financial figure (this module's own `fetchOrder`
// above, plus every `@loxep/inventory/profitability.ts` read model). These
// call the REAL service via `@/server/admin.ts`'s `getOrderIngestionService()`
// (now that `@loxep/commerce` is a declared `apps/web` dependency) — unlike
// this file's reads, there is no raw-SQL twin to note for later removal.
//
// `reattributeOrders` (the bulk, connection-scoped correction) is NOT mounted
// in this pass — see this bead's report.
// ---------------------------------------------------------------------------

const setOrderAttributionInput = z.strictObject({
  orderId: z.uuid(),
  economicEntityId: z.uuid().nullable()
});

export const setOrderAttribution = createServerFn({ method: 'POST' })
  .inputValidator(setOrderAttributionInput)
  .handler(async ({ data }): Promise<{ orderId: string; economicEntityId: string | null }> => {
    const { requireSession, getOrderIngestionService } = await import('@/server/admin');
    const session = await requireSession();
    const orderIngestionService = await getOrderIngestionService();
    return orderIngestionService.setOrderAttribution({
      orderId: data.orderId,
      economicEntityId: data.economicEntityId,
      actorUserId: session.user.id
    });
  });

// ---------------------------------------------------------------------------
// Reads — order fee trend (loxep-8e2 item 3, `/commerce/overview`).
// ---------------------------------------------------------------------------

/**
 * Bound: `order_fees.charged_at >= now() - 90 days`. "Did eBay's rate change,
 * and what is promoted-listing spend costing me?" is a recent-trend question,
 * not a full-history one, and `order_fees_fee_type_charged_at_idx` already
 * covers this predicate. Only `fee_direction = 'seller_charge'` rows are
 * read — `buyer_surcharge` is a pass-through already inside `orders.total`
 * (never a cost to the seller), so it does not belong in a take-rate/spend
 * chart. `chargedAt` is filtered not-null at the query level (a fee with no
 * charge timestamp cannot be placed on a time series) and the row shape is
 * narrowed to that fact below rather than carrying a nullable field the
 * client would have to re-check.
 */
const ORDER_FEE_TREND_WINDOW_DAYS = 90;

export interface OrderFeeTrendPointDto {
  feeType: string;
  currency: string;
  amount: string;
  chargedAt: string;
}

export const fetchOrderFeeTrends = createServerFn({ method: 'GET' }).handler(
  async (): Promise<OrderFeeTrendPointDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const since = new Date(Date.now() - ORDER_FEE_TREND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await handle.db.query.orderFees.findMany({
      where: (table, { and, eq, gte, isNotNull }) =>
        and(
          eq(table.feeDirection, 'seller_charge'),
          isNotNull(table.chargedAt),
          gte(table.chargedAt, since)
        ),
      columns: { feeType: true, currency: true, amount: true, chargedAt: true },
      orderBy: (table, { asc }) => [asc(table.chargedAt)]
    });

    return rows
      .filter((row): row is typeof row & { chargedAt: Date } => row.chargedAt !== null)
      .map((row) => ({
        feeType: row.feeType,
        currency: row.currency,
        amount: row.amount,
        chargedAt: iso(row.chargedAt)
      }));
  }
);

export interface DuplicateOrderCandidateDto {
  provider: string;
  sourceAccountKey: string;
  externalOrderId: string;
  orderIds: string[];
  connectionIds: string[];
}

/**
 * The cross-connection duplicate diagnostic (design open question 2,
 * `orders.ts`'s own `markDuplicate` doc) — READ-ONLY: it reports candidates,
 * it does not mark them. Duplicates are already silently excluded from every
 * profitability figure (`duplicate_of_order_id is null` in every predicate);
 * this is the worklist that makes the exclusion visible instead of silent.
 */
export const fetchDuplicateOrderCandidates = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DuplicateOrderCandidateDto[]> => {
    const { requireSession, getOrderIngestionService } = await import('@/server/admin');
    await requireSession();
    const orderIngestionService = await getOrderIngestionService();
    return orderIngestionService.findDuplicateOrderCandidates();
  }
);
