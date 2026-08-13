/**
 * Order ingestion (loxep-xh9.7): `CommerceOrderFact` → `orders` and its
 * attachments, idempotently, inside one transaction.
 *
 * Jobs are at-least-once, so every write path here is an upsert keyed on a
 * value the adapter can always recompute from the provider payload alone. The
 * order key is `unique(connection_id, provider, external_order_id)` —
 * connection-scoped, because a WooCommerce order id is a per-store integer.
 *
 * ## Attribution is written ONCE
 *
 * The economic entity is a STORED fact on the order, resolved at first
 * normalization and never touched by a later sync. Re-fetching an order must
 * not change what it belonged to, and re-attributing a CONNECTION must not
 * retroactively rewrite history that has already been reported on. Changing
 * attribution afterwards is an explicit, audited operator action
 * ({@link OrderIngestionService.setOrderAttribution} /
 * {@link OrderIngestionService.reattributeOrders}), which may rewrite
 * `connection_default` and `unattributed` rows and must never rewrite
 * `manual` ones.
 *
 * ## Re-sync strategy per attachment kind
 *
 * `order_lines` are matched IN PLACE by stable external line identity (falling
 * back to position), because `order_refund_lines` and
 * `order_fulfillment_lines` reference them and a delete-and-replace would
 * cascade those away on every sync. Surviving rows are first shifted into
 * negative `line_number` space so a provider that renumbered its lines cannot
 * collide with `unique(order_id, line_number)` mid-rewrite.
 *
 * `order_fees`, `order_refunds`, and `order_fulfillments` ARE
 * delete-and-replaced inside the same transaction as the order update — the
 * strategy the design document prescribes for attachments — because they have
 * no inbound references within Phase 3 and rebuilding them is the only way to
 * make a shrinking provider array (a reversed refund) actually disappear.
 *
 * ## PROVISIONAL: automatic duplicate marking
 *
 * Two connections authorized against the same seller account legitimately
 * fetch the same order, and the connection-scoped key produces two rows. This
 * service DETECTS that (per design open question 2) and links the later row to
 * the canonical one via `duplicate_of_order_id`. It never deletes evidence and
 * never enforces a constraint: a wrong constraint fails ingestion, a wrong
 * report is fixable. Pass `markDuplicates: false` to record the fact without
 * acting on it.
 */
import { createHash } from "node:crypto";
import type { LoxepDb } from "@loxep/db";
import {
  orderFees,
  orderFulfillmentLines,
  orderFulfillments,
  orderLines,
  orderRefundLines,
  orderRefunds,
  orderSourceLinks,
  orders,
  providerObjects,
} from "@loxep/db/schema";
import type { EntityAttributionSource } from "@loxep/db/schema";
import { createAuditService } from "@loxep/domain";
import type { WooOrderFact } from "@loxep/integration-woo";
import { z } from "zod";
import { toMoneyString } from "./decimal.ts";
import { CommerceNotFoundError, CommerceValidationError } from "./errors.ts";
import type {
  CommerceOrderFact,
  CommerceOrderFulfillmentFact,
  CommerceOrderRefundFact,
} from "./facts.ts";
import { textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";
import { ebayOrderFactToCommerceFact } from "./ebay.ts";
import type {
  EbayOrderFactLike,
  EbayTranslationOptions,
} from "./ebay.ts";
import { medusaOrderFactToCommerceFact } from "./medusa.ts";
import type {
  MedusaOrderFactLike,
  MedusaTranslationOptions,
} from "./medusa.ts";
import { wooOrderFactToCommerceFact } from "./woo.ts";
import type { WooTranslationOptions } from "./woo.ts";

/* ------------------------------------------------------------- validation */

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a plain decimal string");
const positiveDecimalString = decimalString.refine(
  (value) => /[1-9]/.test(value.replace("-", "")),
  "expected a non-zero quantity",
);
const isoInstant = z.iso.datetime({ offset: true });
const currencyCode = z.string().regex(/^[A-Za-z]{3}$/, "expected ISO-4217");

const lineFactSchema = z.object({
  lineNumber: z.number().int().positive(),
  externalLineId: z.string().min(1).nullable(),
  externalItemId: z.string().min(1).nullable(),
  externalVariationId: z.string().min(1).nullable(),
  channelSku: z.string().min(1).nullable(),
  title: z.string().nullable(),
  quantity: positiveDecimalString,
  unitPrice: decimalString,
  lineSubtotal: decimalString,
  discountAmount: decimalString,
  taxAmount: decimalString,
  shippingAmount: decimalString,
  refundedAmount: decimalString,
  lineTotal: decimalString,
});

const feeFactSchema = z
  .object({
    externalFeeId: z.string().min(1).nullable(),
    feeScope: z.enum(["order", "line"]),
    lineNumber: z.number().int().positive().nullable(),
    feeDirection: z.enum(["seller_charge", "buyer_surcharge"]),
    feeType: z.string().min(1),
    providerFeeCode: z.string().min(1).nullable(),
    description: z.string().nullable(),
    currency: currencyCode,
    amount: decimalString,
    chargedAt: isoInstant.nullable(),
  })
  .refine((fee) => (fee.feeScope === "line") === (fee.lineNumber !== null), {
    message: "fee_scope 'line' requires a lineNumber, and vice versa",
    path: ["lineNumber"],
  });

const refundFactSchema = z.object({
  externalRefundId: z.string().min(1).nullable(),
  kind: z.string().min(1),
  status: z.string().min(1),
  reasonCode: z.string().nullable(),
  currency: currencyCode,
  amount: decimalString,
  refundedAt: isoInstant.nullable(),
  lines: z.array(
    z.object({
      lineNumber: z.number().int().positive().nullable(),
      quantity: decimalString.nullable(),
      amount: decimalString,
    }),
  ),
});

const fulfillmentFactSchema = z.object({
  externalFulfillmentId: z.string().min(1).nullable(),
  status: z.string().min(1),
  carrierCode: z.string().min(1).nullable(),
  carrierName: z.string().min(1).nullable(),
  serviceCode: z.string().min(1).nullable(),
  trackingNumber: z.string().min(1).nullable(),
  trackingUrl: z.string().min(1).nullable(),
  shippedAt: isoInstant.nullable(),
  deliveredAt: isoInstant.nullable(),
  destinationCountry: z.string().length(2).nullable(),
  destinationRegion: z.string().min(1).nullable(),
  lines: z.array(
    z.object({
      lineNumber: z.number().int().positive(),
      quantity: positiveDecimalString,
    }),
  ),
});

/**
 * Boundary validation for the provider-neutral fact. Zod at the boundary
 * (implementation contract) so a translator bug surfaces as a named error
 * instead of a PostgreSQL constraint violation three tables deep.
 */
export const commerceOrderFactSchema = z.object({
  provider: z.string().min(1),
  channel: z.string().min(1),
  marketplace: z.string().min(1).nullable(),
  sourceAccountKey: z.string().min(1),
  externalOrderId: z.string().min(1),
  externalOrderNumber: z.string().min(1).nullable(),
  status: z.string().min(1),
  paymentStatus: z.string().min(1),
  fulfillmentStatus: z.string().min(1),
  providerStatusRaw: z.string().nullable(),
  currency: currencyCode,
  subtotalAmount: decimalString,
  shippingAmount: decimalString,
  discountAmount: decimalString,
  taxAmount: decimalString,
  feeAmount: decimalString,
  refundedAmount: decimalString,
  totalAmount: decimalString,
  buyerExternalId: z.string().min(1).nullable(),
  buyerDisplayName: z.string().min(1).nullable(),
  placedAt: isoInstant,
  providerUpdatedAt: isoInstant.nullable(),
  cancelledAt: isoInstant.nullable(),
  lines: z.array(lineFactSchema),
  fees: z.array(feeFactSchema),
  refunds: z.array(refundFactSchema),
  fulfillments: z.array(fulfillmentFactSchema),
  rawPayload: z.record(z.string(), z.unknown()).nullable(),
  providerObjectType: z.string().min(1),
});

/* ------------------------------------------------------------------ types */

/** What one ingestion call did. */
export interface IngestOrderResult {
  orderId: string;
  /** True when this call inserted the order row. */
  created: boolean;
  /** `order_source_links.effect` for this observation. */
  effect: "created" | "updated" | "unchanged";
  economicEntityId: string | null;
  entityAttributionSource: EntityAttributionSource;
  /** Set when this row was detected as a cross-connection duplicate. */
  duplicateOfOrderId: string | null;
  lineCount: number;
  feeCount: number;
  refundCount: number;
  fulfillmentCount: number;
  /** The `provider_objects` row this observation retained or reused. */
  providerObjectId: string | null;
}

export interface IngestOrderFactInput {
  connectionId: string;
  fact: CommerceOrderFact;
  /**
   * Explicit per-order attribution. Wins over the connection default, and is
   * honoured only at FIRST normalization — a later sync passing a different
   * value is ignored, because attribution is history, not configuration.
   */
  economicEntityId?: string | null;
  /** Recorded on `entity_attributed_by_user_id` when attribution is explicit. */
  actorUserId?: string | null;
  /** Link the observation to an already-retained `source_events` row. */
  sourceEventId?: string | null;
  /** Retain `fact.rawPayload` in `provider_objects` (default true). */
  retainProviderObject?: boolean;
  /** PROVISIONAL: auto-link cross-connection duplicates (default true). */
  markDuplicates?: boolean;
  /** Deterministic clock for tests. */
  now?: Date;
}

export interface IngestWooOrderInput
  extends Omit<IngestOrderFactInput, "fact">,
    WooTranslationOptions {
  fact: WooOrderFact;
}

/**
 * The eBay entry point. `fact` is typed against this package's structural
 * re-declaration of the adapter's shape rather than an imported provider type
 * — see `ebay.ts` for why `@loxep/commerce` takes no dependency on
 * `@loxep/integration-ebay`.
 */
export interface IngestEbayOrderInput
  extends Omit<IngestOrderFactInput, "fact">,
    EbayTranslationOptions {
  fact: EbayOrderFactLike;
}

/**
 * The Medusa entry point. `fact` is typed against this package's structural
 * re-declaration of the adapter's shape rather than an imported provider type
 * — see `medusa.ts` for why `@loxep/commerce` takes no dependency on
 * `@loxep/integration-medusa`.
 */
export interface IngestMedusaOrderInput
  extends Omit<IngestOrderFactInput, "fact">,
    MedusaTranslationOptions {
  fact: MedusaOrderFactLike;
}

/** One row of the cross-connection duplicate diagnostic. */
export interface DuplicateOrderCandidate {
  provider: string;
  sourceAccountKey: string;
  externalOrderId: string;
  orderIds: string[];
  connectionIds: string[];
}

export interface SetOrderAttributionInput {
  orderId: string;
  economicEntityId: string | null;
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface ReattributeOrdersInput {
  connectionId: string;
  economicEntityId: string | null;
  /** Only orders placed strictly before this instant. */
  placedBefore?: Date;
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface OrderIngestionService {
  /** Persist one provider-neutral order fact. Idempotent. */
  ingestOrderFact: (input: IngestOrderFactInput) => Promise<IngestOrderResult>;
  /** Translate a WooCommerce fact and persist it. Idempotent. */
  ingestWooOrder: (input: IngestWooOrderInput) => Promise<IngestOrderResult>;
  /** Translate an eBay fact and persist it. Idempotent. */
  ingestEbayOrder: (input: IngestEbayOrderInput) => Promise<IngestOrderResult>;
  /** Translate a Medusa fact and persist it. Idempotent. */
  ingestMedusaOrder: (
    input: IngestMedusaOrderInput,
  ) => Promise<IngestOrderResult>;
  /** Read-only diagnostic: orders that look like the same sale twice. */
  findDuplicateOrderCandidates: (options?: {
    provider?: string;
    limit?: number;
  }) => Promise<DuplicateOrderCandidate[]>;
  /** Explicit, audited per-order override. Flips the source to `manual`. */
  setOrderAttribution: (
    input: SetOrderAttributionInput,
  ) => Promise<{ orderId: string; economicEntityId: string | null }>;
  /**
   * Explicit, audited bulk re-attribution. Rewrites only rows whose source is
   * `connection_default` or `unattributed`; `manual` rows are never touched.
   */
  reattributeOrders: (
    input: ReattributeOrdersInput,
  ) => Promise<{ updated: number }>;
}

/* -------------------------------------------------------------- internals */

type Executor = Parameters<Parameters<LoxepDb["transaction"]>[0]>[0];

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

interface ResolvedAttribution {
  economicEntityId: string | null;
  entityAttributionSource: EntityAttributionSource;
  entityAttributedAt: Date | null;
  entityAttributedByUserId: string | null;
}

/**
 * The design's precedence, applied ONLY at first normalization:
 *
 * ```text
 * 1. explicit per-order value set by an operator   -> 'manual'
 * 2. snapshot of connections.economic_entity_id    -> 'connection_default'
 * 3. nothing available                             -> 'unattributed', null
 * ```
 *
 * Nullable on purpose: ingestion must never fail or block on an unattributed
 * connection. An unattributed order is a visible backlog to resolve, not a
 * rejected fact.
 */
export function resolveAttribution(input: {
  explicitEntityId?: string | null;
  connectionEntityId: string | null;
  actorUserId?: string | null;
  now: Date;
}): ResolvedAttribution {
  if (input.explicitEntityId !== undefined && input.explicitEntityId !== null) {
    return {
      economicEntityId: input.explicitEntityId,
      entityAttributionSource: "manual",
      entityAttributedAt: input.now,
      entityAttributedByUserId: input.actorUserId ?? null,
    };
  }
  if (input.connectionEntityId !== null) {
    return {
      economicEntityId: input.connectionEntityId,
      entityAttributionSource: "connection_default",
      entityAttributedAt: null,
      entityAttributedByUserId: null,
    };
  }
  return {
    economicEntityId: null,
    entityAttributionSource: "unattributed",
    entityAttributedAt: null,
    entityAttributedByUserId: null,
  };
}

/** Order-level scalars whose change makes an observation an `update`. */
function orderSignature(values: {
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  providerStatusRaw: string | null;
  totalAmount: string;
  refundedAmount: string;
  feeAmount: string;
  providerUpdatedAt: Date | null;
  lineCount: number;
}): string {
  return [
    values.status,
    values.paymentStatus,
    values.fulfillmentStatus,
    values.providerStatusRaw ?? "",
    // Normalized to numeric(20,6) so "10.00" and the "10.000000" PostgreSQL
    // echoes back are the same fact, not a spurious update.
    toMoneyString(values.totalAmount),
    toMoneyString(values.refundedAmount),
    toMoneyString(values.feeAmount),
    values.providerUpdatedAt?.toISOString() ?? "",
    String(values.lineCount),
  ].join("|");
}

function toDateOrNull(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/* ---------------------------------------------------------------- service */

export function createOrderIngestionService(options: {
  db: LoxepDb;
}): OrderIngestionService {
  const { db } = options;

  async function ingestOrderFact(
    input: IngestOrderFactInput,
  ): Promise<IngestOrderResult> {
    const parsed = commerceOrderFactSchema.safeParse(input.fact);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
        .join("; ");
      throw new CommerceValidationError(`invalid order fact: ${issues}`);
    }
    const fact = parsed.data as CommerceOrderFact;
    const now = input.now ?? new Date();

    return db.transaction(async (tx) => {
      const connection = await tx.query.connections.findFirst({
        where: (table, { eq }) => eq(table.id, input.connectionId),
        columns: { id: true, economicEntityId: true },
      });
      if (connection === undefined) {
        throw new CommerceNotFoundError(
          `unknown connection "${input.connectionId}"`,
        );
      }

      const existing = await tx.query.orders.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.connectionId, input.connectionId),
            eq(table.provider, fact.provider),
            eq(table.externalOrderId, fact.externalOrderId),
          ),
      });
      const created = existing === undefined;

      const attribution = existing === undefined
        ? resolveAttribution({
            ...(input.economicEntityId === undefined
              ? {}
              : { explicitEntityId: input.economicEntityId }),
            connectionEntityId: connection.economicEntityId,
            actorUserId: input.actorUserId ?? null,
            now,
          })
        : {
            economicEntityId: existing.economicEntityId,
            entityAttributionSource:
              existing.entityAttributionSource as EntityAttributionSource,
            entityAttributedAt: existing.entityAttributedAt,
            entityAttributedByUserId: existing.entityAttributedByUserId,
          };

      const mutableValues = {
        channel: fact.channel,
        marketplace: fact.marketplace,
        sourceAccountKey: fact.sourceAccountKey,
        externalOrderNumber: fact.externalOrderNumber,
        status: fact.status,
        paymentStatus: fact.paymentStatus,
        fulfillmentStatus: fact.fulfillmentStatus,
        providerStatusRaw: fact.providerStatusRaw,
        currency: fact.currency.toUpperCase(),
        subtotalAmount: fact.subtotalAmount,
        shippingAmount: fact.shippingAmount,
        discountAmount: fact.discountAmount,
        taxAmount: fact.taxAmount,
        feeAmount: fact.feeAmount,
        refundedAmount: fact.refundedAmount,
        totalAmount: fact.totalAmount,
        buyerExternalId: fact.buyerExternalId,
        buyerDisplayName: fact.buyerDisplayName,
        placedAt: new Date(fact.placedAt),
        providerUpdatedAt: toDateOrNull(fact.providerUpdatedAt),
        cancelledAt: toDateOrNull(fact.cancelledAt),
        lastSyncedAt: now,
        updatedAt: now,
      };

      const upserted = await tx
        .insert(orders)
        .values({
          connectionId: input.connectionId,
          provider: fact.provider,
          externalOrderId: fact.externalOrderId,
          ...attribution,
          ...mutableValues,
          firstIngestedAt: now,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [orders.connectionId, orders.provider, orders.externalOrderId],
          // Attribution, first_ingested_at, created_at, and
          // duplicate_of_order_id are deliberately absent: they are history,
          // not provider facts.
          set: mutableValues,
        })
        .returning({ id: orders.id });
      const orderId = upserted[0]?.id;
      if (orderId === undefined) {
        throw new CommerceNotFoundError("order upsert returned no row");
      }

      const { lineIdByNumber, previousLineCount } = await rewriteLines(
        tx,
        orderId,
        fact,
        now,
      );
      await rewriteAttachments(tx, orderId, fact, lineIdByNumber, now);

      let effect: IngestOrderResult["effect"] = "created";
      if (existing !== undefined) {
        const before = orderSignature({
          status: existing.status,
          paymentStatus: existing.paymentStatus,
          fulfillmentStatus: existing.fulfillmentStatus,
          providerStatusRaw: existing.providerStatusRaw,
          totalAmount: existing.totalAmount,
          refundedAmount: existing.refundedAmount,
          feeAmount: existing.feeAmount,
          providerUpdatedAt: existing.providerUpdatedAt,
          lineCount: previousLineCount,
        });
        const after = orderSignature({
          status: fact.status,
          paymentStatus: fact.paymentStatus,
          fulfillmentStatus: fact.fulfillmentStatus,
          providerStatusRaw: fact.providerStatusRaw,
          totalAmount: fact.totalAmount,
          refundedAmount: fact.refundedAmount,
          feeAmount: fact.feeAmount,
          providerUpdatedAt: toDateOrNull(fact.providerUpdatedAt),
          lineCount: fact.lines.length,
        });
        effect = before === after ? "unchanged" : "updated";
      }

      const providerObjectId = await retainProvenance(tx, {
        orderId,
        connectionId: input.connectionId,
        fact,
        effect,
        now,
        retain: input.retainProviderObject !== false,
        sourceEventId: input.sourceEventId ?? null,
      });

      const duplicateOfOrderId =
        input.markDuplicates === false
          ? (existing === undefined ? null : existing.duplicateOfOrderId)
          : await markDuplicate(tx, orderId, fact);

      return {
        orderId,
        created,
        effect,
        economicEntityId: attribution.economicEntityId,
        entityAttributionSource: attribution.entityAttributionSource,
        duplicateOfOrderId,
        lineCount: fact.lines.length,
        feeCount: fact.fees.length,
        refundCount: fact.refunds.length,
        fulfillmentCount: fact.fulfillments.length,
        providerObjectId,
      };
    });
  }

  async function ingestWooOrder(
    input: IngestWooOrderInput,
  ): Promise<IngestOrderResult> {
    const { fact, channel, retainRawPayload, ...rest } = input;
    return ingestOrderFact({
      ...rest,
      fact: wooOrderFactToCommerceFact(fact, {
        ...(channel === undefined ? {} : { channel }),
        ...(retainRawPayload === undefined ? {} : { retainRawPayload }),
      }),
    });
  }

  async function ingestEbayOrder(
    input: IngestEbayOrderInput,
  ): Promise<IngestOrderResult> {
    const { fact, channel, retainRawPayload, ...rest } = input;
    return ingestOrderFact({
      ...rest,
      fact: ebayOrderFactToCommerceFact(fact, {
        ...(channel === undefined ? {} : { channel }),
        ...(retainRawPayload === undefined ? {} : { retainRawPayload }),
      }),
    });
  }

  async function ingestMedusaOrder(
    input: IngestMedusaOrderInput,
  ): Promise<IngestOrderResult> {
    const { fact, channel, retainRawPayload, ...rest } = input;
    return ingestOrderFact({
      ...rest,
      fact: medusaOrderFactToCommerceFact(fact, {
        ...(channel === undefined ? {} : { channel }),
        ...(retainRawPayload === undefined ? {} : { retainRawPayload }),
      }),
    });
  }

  async function findDuplicateOrderCandidates(
    options: { provider?: string; limit?: number } = {},
  ): Promise<DuplicateOrderCandidate[]> {
    const providerFilter =
      options.provider === undefined
        ? ""
        : `where provider = ${textLiteral(options.provider)}`;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    const result = await db.execute(
      `select provider,
              source_account_key,
              external_order_id,
              array_agg(id::text order by first_ingested_at, id) as order_ids,
              array_agg(connection_id::text order by first_ingested_at, id)
                as connection_ids
         from orders
         ${providerFilter}
        group by provider, source_account_key, external_order_id
       having count(distinct connection_id) > 1
        order by provider, source_account_key, external_order_id
        limit ${limit}`,
    );
    return result.rows.map((row) => ({
      provider: row["provider"] as string,
      sourceAccountKey: row["source_account_key"] as string,
      externalOrderId: row["external_order_id"] as string,
      orderIds: row["order_ids"] as string[],
      connectionIds: row["connection_ids"] as string[],
    }));
  }

  async function setOrderAttribution(
    input: SetOrderAttributionInput,
  ): Promise<{ orderId: string; economicEntityId: string | null }> {
    return db.transaction(async (tx) => {
      const existing = await tx.query.orders.findFirst({
        where: (table, { eq }) => eq(table.id, input.orderId),
        columns: {
          id: true,
          economicEntityId: true,
          entityAttributionSource: true,
        },
      });
      if (existing === undefined) {
        throw new CommerceNotFoundError(`unknown order "${input.orderId}"`);
      }
      const now = new Date();
      const entityLiteral =
        input.economicEntityId === null
          ? "null"
          : `${uuidLiteral(input.economicEntityId)}::uuid`;
      const actorLiteral =
        input.actorUserId === undefined || input.actorUserId === null
          ? "null"
          : textLiteral(input.actorUserId);
      await tx.execute(
        `update orders
            set economic_entity_id = ${entityLiteral},
                entity_attribution_source = 'manual',
                entity_attributed_at = ${timestamptzLiteral(now)},
                entity_attributed_by_user_id = ${actorLiteral},
                updated_at = ${timestamptzLiteral(now)}
          where id = ${uuidLiteral(input.orderId)}`,
      );
      await createAuditService({ db: tx }).append({
        actorUserId: input.actorUserId ?? null,
        action: "commerce.order.attribute",
        resourceType: "order",
        resourceId: input.orderId,
        before: {
          economicEntityId: existing.economicEntityId,
          entityAttributionSource: existing.entityAttributionSource,
        },
        after: {
          economicEntityId: input.economicEntityId,
          entityAttributionSource: "manual",
        },
        requestId: input.requestId ?? null,
      });
      return {
        orderId: input.orderId,
        economicEntityId: input.economicEntityId,
      };
    });
  }

  async function reattributeOrders(
    input: ReattributeOrdersInput,
  ): Promise<{ updated: number }> {
    return db.transaction(async (tx) => {
      const now = new Date();
      const entityLiteral =
        input.economicEntityId === null
          ? "null"
          : `${uuidLiteral(input.economicEntityId)}::uuid`;
      const actorLiteral =
        input.actorUserId === undefined || input.actorUserId === null
          ? "null"
          : textLiteral(input.actorUserId);
      const placedFilter =
        input.placedBefore === undefined
          ? ""
          : ` and placed_at < ${timestamptzLiteral(input.placedBefore)}`;
      const result = await tx.execute(
        `update orders
            set economic_entity_id = ${entityLiteral},
                entity_attribution_source = ${
                  input.economicEntityId === null
                    ? "'unattributed'"
                    : "'connection_default'"
                },
                entity_attributed_at = ${timestamptzLiteral(now)},
                entity_attributed_by_user_id = ${actorLiteral},
                updated_at = ${timestamptzLiteral(now)}
          where connection_id = ${uuidLiteral(input.connectionId)}
            and entity_attribution_source in ('connection_default', 'unattributed')
            ${placedFilter}
          returning id`,
      );
      const updated = result.rows.length;
      await createAuditService({ db: tx }).append({
        actorUserId: input.actorUserId ?? null,
        action: "commerce.orders.reattribute",
        resourceType: "connection",
        resourceId: input.connectionId,
        after: {
          economicEntityId: input.economicEntityId,
          placedBefore: input.placedBefore?.toISOString() ?? null,
          updated,
        },
        requestId: input.requestId ?? null,
        metadata: {
          note: "manual attributions are never rewritten by bulk re-attribution",
        },
      });
      return { updated };
    });
  }

  return {
    ingestOrderFact,
    ingestWooOrder,
    ingestEbayOrder,
    ingestMedusaOrder,
    findDuplicateOrderCandidates,
    setOrderAttribution,
    reattributeOrders,
  };
}

/* ------------------------------------------------------------ line rewrite */

/**
 * Match incoming lines onto existing rows by stable external line identity
 * (positional fallback), delete the ones the provider dropped, update the
 * survivors in place, and insert the new ones.
 *
 * Preserving `order_lines.id` is the whole point: `order_refund_lines` and
 * `order_fulfillment_lines` reference it, and re-creating lines every sync
 * would cascade those rows away and make partial-fulfillment history
 * disappear on a routine re-fetch.
 */
async function rewriteLines(
  tx: Executor,
  orderId: string,
  fact: CommerceOrderFact,
  now: Date,
): Promise<{ lineIdByNumber: Map<number, string>; previousLineCount: number }> {
  const existing = await tx.query.orderLines.findMany({
    where: (table, { eq }) => eq(table.orderId, orderId),
    columns: { id: true, lineNumber: true, externalLineId: true },
  });

  const byExternalId = new Map<string, (typeof existing)[number]>();
  const byLineNumber = new Map<number, (typeof existing)[number]>();
  for (const row of existing) {
    if (row.externalLineId !== null) byExternalId.set(row.externalLineId, row);
    byLineNumber.set(row.lineNumber, row);
  }

  const matchedIds = new Set<string>();
  const matches = new Map<number, string>();
  for (const line of fact.lines) {
    const candidate =
      line.externalLineId !== null
        ? byExternalId.get(line.externalLineId)
        : byLineNumber.get(line.lineNumber);
    if (candidate !== undefined && !matchedIds.has(candidate.id)) {
      matchedIds.add(candidate.id);
      matches.set(line.lineNumber, candidate.id);
    }
  }

  const orphaned = existing.filter((row) => !matchedIds.has(row.id));
  if (orphaned.length > 0) {
    await tx.execute(
      `delete from order_lines where id in (${orphaned
        .map((row) => uuidLiteral(row.id))
        .join(", ")})`,
    );
  }

  // Park survivors in negative line-number space so a provider that renumbered
  // its lines cannot transiently violate unique(order_id, line_number). The
  // CHECK constraint is on `quantity`, not on `line_number`, so this is legal.
  if (matches.size > 0) {
    await tx.execute(
      `update order_lines
          set line_number = -line_number
        where order_id = ${uuidLiteral(orderId)}
          and line_number > 0`,
    );
  }

  const lineIdByNumber = new Map<number, string>();
  for (const line of fact.lines) {
    const values = {
      orderId,
      lineNumber: line.lineNumber,
      externalLineId: line.externalLineId,
      externalItemId: line.externalItemId,
      externalVariationId: line.externalVariationId,
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
      updatedAt: now,
    };
    const existingId = matches.get(line.lineNumber);
    if (existingId === undefined) {
      const inserted = await tx
        .insert(orderLines)
        .values({ ...values, createdAt: now })
        .returning({ id: orderLines.id });
      const id = inserted[0]?.id;
      if (id === undefined) {
        throw new CommerceNotFoundError("order line insert returned no row");
      }
      lineIdByNumber.set(line.lineNumber, id);
      continue;
    }
    // Primary-key upsert: the package's standing pattern for UPDATE without a
    // direct drizzle-orm dependency (mirrors @loxep/market).
    await tx
      .insert(orderLines)
      .values({ id: existingId, ...values, createdAt: now })
      .onConflictDoUpdate({ target: orderLines.id, set: values });
    lineIdByNumber.set(line.lineNumber, existingId);
  }
  return { lineIdByNumber, previousLineCount: existing.length };
}

/* ----------------------------------------------------- attachment rewrite */

/**
 * Delete-and-replace of `order_fees`, `order_refunds`, and
 * `order_fulfillments` inside the order's transaction — the strategy the
 * design document prescribes. Their child rows cascade.
 */
async function rewriteAttachments(
  tx: Executor,
  orderId: string,
  fact: CommerceOrderFact,
  lineIdByNumber: Map<number, string>,
  now: Date,
): Promise<void> {
  const orderLiteral = uuidLiteral(orderId);
  await tx.execute(`delete from order_fees where order_id = ${orderLiteral}`);
  await tx.execute(
    `delete from order_refunds where order_id = ${orderLiteral}`,
  );
  await tx.execute(
    `delete from order_fulfillments where order_id = ${orderLiteral}`,
  );

  const resolveLineId = (lineNumber: number | null): string | null => {
    if (lineNumber === null) return null;
    const id = lineIdByNumber.get(lineNumber);
    if (id === undefined) {
      throw new CommerceValidationError(
        `attachment references line ${lineNumber}, which the order does not have`,
      );
    }
    return id;
  };

  if (fact.fees.length > 0) {
    await tx.insert(orderFees).values(
      fact.fees.map((fee) => ({
        orderId,
        orderLineId: resolveLineId(fee.lineNumber),
        feeScope: fee.feeScope,
        feeDirection: fee.feeDirection,
        feeType: fee.feeType,
        providerFeeCode: fee.providerFeeCode,
        externalFeeId: fee.externalFeeId,
        description: fee.description,
        currency: fee.currency.toUpperCase(),
        amount: fee.amount,
        chargedAt: toDateOrNull(fee.chargedAt),
        createdAt: now,
        updatedAt: now,
      })),
    );
  }

  for (const refund of fact.refunds) {
    await insertRefund(tx, orderId, refund, resolveLineId, now);
  }
  for (const fulfillment of fact.fulfillments) {
    await insertFulfillment(tx, orderId, fulfillment, lineIdByNumber, now);
  }
}

async function insertRefund(
  tx: Executor,
  orderId: string,
  refund: CommerceOrderRefundFact,
  resolveLineId: (lineNumber: number | null) => string | null,
  now: Date,
): Promise<void> {
  const inserted = await tx
    .insert(orderRefunds)
    .values({
      orderId,
      externalRefundId: refund.externalRefundId,
      kind: refund.kind,
      status: refund.status,
      reasonCode: refund.reasonCode,
      currency: refund.currency.toUpperCase(),
      amount: refund.amount,
      refundedAt: toDateOrNull(refund.refundedAt),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: orderRefunds.id });
  const refundId = inserted[0]?.id;
  if (refundId === undefined) {
    throw new CommerceNotFoundError("order refund insert returned no row");
  }
  if (refund.lines.length === 0) return;
  await tx.insert(orderRefundLines).values(
    refund.lines.map((line) => ({
      orderRefundId: refundId,
      orderLineId: resolveLineId(line.lineNumber),
      quantity: line.quantity,
      amount: line.amount,
      createdAt: now,
    })),
  );
}

async function insertFulfillment(
  tx: Executor,
  orderId: string,
  fulfillment: CommerceOrderFulfillmentFact,
  lineIdByNumber: Map<number, string>,
  now: Date,
): Promise<void> {
  const inserted = await tx
    .insert(orderFulfillments)
    .values({
      orderId,
      externalFulfillmentId: fulfillment.externalFulfillmentId,
      status: fulfillment.status,
      carrierCode: fulfillment.carrierCode,
      carrierName: fulfillment.carrierName,
      serviceCode: fulfillment.serviceCode,
      trackingNumber: fulfillment.trackingNumber,
      trackingUrl: fulfillment.trackingUrl,
      shippedAt: toDateOrNull(fulfillment.shippedAt),
      deliveredAt: toDateOrNull(fulfillment.deliveredAt),
      destinationCountry:
        fulfillment.destinationCountry === null
          ? null
          : fulfillment.destinationCountry.toUpperCase(),
      destinationRegion: fulfillment.destinationRegion,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: orderFulfillments.id });
  const fulfillmentId = inserted[0]?.id;
  if (fulfillmentId === undefined) {
    throw new CommerceNotFoundError(
      "order fulfillment insert returned no row",
    );
  }
  if (fulfillment.lines.length === 0) return;
  // A fulfillment may only name a line the order actually has; the primary key
  // collapses a provider that repeats a line within one fulfillment.
  const seen = new Set<number>();
  const values: Array<{
    orderFulfillmentId: string;
    orderLineId: string;
    quantity: string;
  }> = [];
  for (const line of fulfillment.lines) {
    if (seen.has(line.lineNumber)) continue;
    seen.add(line.lineNumber);
    const orderLineId = lineIdByNumber.get(line.lineNumber);
    if (orderLineId === undefined) {
      throw new CommerceValidationError(
        `fulfillment references line ${line.lineNumber}, which the order does not have`,
      );
    }
    values.push({
      orderFulfillmentId: fulfillmentId,
      orderLineId,
      quantity: line.quantity,
    });
  }
  if (values.length > 0) {
    await tx.insert(orderFulfillmentLines).values(values);
  }
}

/* ---------------------------------------------------------------- provenance */

/**
 * Retain the verbatim provider payload at the provenance boundary and link it
 * to the order (cross-domain rule 4).
 *
 * An identical payload is NOT stored twice: the most recent
 * `provider_objects` row for the same identity is reused when its
 * `payload_hash` matches, and the existing `order_source_links` row is then
 * left completely untouched — reprocessing the same source fact links once,
 * which is exactly the idempotency the partial uniques exist for. "We looked
 * again and nothing moved" is recorded on `orders.last_synced_at`, which is
 * what that column is for.
 */
async function retainProvenance(
  tx: Executor,
  input: {
    orderId: string;
    connectionId: string;
    fact: CommerceOrderFact;
    effect: IngestOrderResult["effect"];
    now: Date;
    retain: boolean;
    sourceEventId: string | null;
  },
): Promise<string | null> {
  if (input.sourceEventId !== null) {
    const existingLink = await tx.query.orderSourceLinks.findFirst({
      where: (table, { and, eq }) =>
        and(
          eq(table.orderId, input.orderId),
          eq(table.sourceEventId, input.sourceEventId as string),
        ),
      columns: { id: true },
    });
    if (existingLink === undefined) {
      await tx.insert(orderSourceLinks).values({
        orderId: input.orderId,
        sourceEventId: input.sourceEventId,
        effect: input.effect,
        linkedAt: input.now,
      });
    }
  }

  const payload = input.fact.rawPayload;
  if (!input.retain || payload === null) return null;

  const payloadHash = hashPayload(payload);
  const latest = await tx.query.providerObjects.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.connectionId, input.connectionId),
        eq(table.provider, input.fact.provider),
        eq(table.objectType, input.fact.providerObjectType),
        eq(table.externalObjectId, input.fact.externalOrderId),
      ),
    orderBy: (table, { desc }) => [desc(table.fetchedAt)],
    columns: { id: true, payloadHash: true },
  });

  let providerObjectId: string;
  if (latest !== undefined && latest.payloadHash === payloadHash) {
    providerObjectId = latest.id;
  } else {
    const inserted = await tx
      .insert(providerObjects)
      .values({
        connectionId: input.connectionId,
        provider: input.fact.provider,
        objectType: input.fact.providerObjectType,
        externalObjectId: input.fact.externalOrderId,
        fetchedAt: input.now,
        providerUpdatedAt: toDateOrNull(input.fact.providerUpdatedAt),
        payload,
        payloadHash,
      })
      .returning({ id: providerObjects.id });
    const id = inserted[0]?.id;
    if (id === undefined) {
      throw new CommerceNotFoundError("provider object insert returned no row");
    }
    providerObjectId = id;
  }

  const existingLink = await tx.query.orderSourceLinks.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.orderId, input.orderId),
        eq(table.providerObjectId, providerObjectId),
      ),
    columns: { id: true },
  });
  if (existingLink === undefined) {
    await tx.insert(orderSourceLinks).values({
      orderId: input.orderId,
      providerObjectId,
      effect: input.effect,
      linkedAt: input.now,
    });
  }
  return providerObjectId;
}

/* ------------------------------------------------------ duplicate marking */

/**
 * PROVISIONAL (design open question 2). The canonical order for a
 * `(provider, source_account_key, external_order_id)` group is the
 * earliest-ingested row that is not itself marked a duplicate; every other row
 * in the group points at it. Nothing is ever deleted, and no constraint is
 * created — `source_account_key` has to prove itself per provider first.
 */
async function markDuplicate(
  tx: Executor,
  orderId: string,
  fact: CommerceOrderFact,
): Promise<string | null> {
  const result = await tx.execute(
    `select id::text as id
       from orders
      where provider = ${textLiteral(fact.provider)}
        and source_account_key = ${textLiteral(fact.sourceAccountKey)}
        and external_order_id = ${textLiteral(fact.externalOrderId)}
        and duplicate_of_order_id is null
      order by first_ingested_at asc, id asc`,
  );
  const canonicalId = result.rows[0]?.["id"] as string | undefined;
  if (canonicalId === undefined || canonicalId === orderId) return null;
  await tx.execute(
    `update orders
        set duplicate_of_order_id = ${uuidLiteral(canonicalId)},
            updated_at = now()
      where id = ${uuidLiteral(orderId)}
        and duplicate_of_order_id is null`,
  );
  return canonicalId;
}
