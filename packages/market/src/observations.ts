/**
 * Observation write path (loxep-ubx.2) over the
 * `marketplace_item_observations` Timescale hypertable plus canonical
 * `marketplace_items` identity and `monitor_items` link maintenance.
 *
 * ## Retry identity / batch idempotency
 *
 * `observation_batch_id` is minted ONCE when a provider fetch/poll result is
 * obtained and `observed_at` is fixed at that same moment; both are retained
 * across processing retries (the caller passes them in — this module never
 * regenerates them). The batch write is a single multi-row
 * `INSERT ... ON CONFLICT (observation_batch_id, marketplace_item_id,
 * observed_at) DO NOTHING`, so a retried at-least-once handler re-inserting
 * the same batch conflicts row-by-row instead of duplicating, while two
 * distinct batches observing the same item at the same instant both land.
 *
 * ## NULL preservation
 *
 * Missing/unobservable metrics stay NULL — absence is never normalized to 0.
 * Optional fields omitted from an item are simply not written.
 *
 * Money/decimal fields (`price`, `shipping_price`, `seller_feedback_pct`)
 * travel as decimal STRINGS end to end (PostgreSQL `numeric`); this module
 * performs no JavaScript number arithmetic on them.
 */
import { marketplaceItemObservations } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { MarketNotFoundError, MarketValidationError } from "./errors.ts";
import { textLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "expected a decimal string");

export const observationItemSchema = z.strictObject({
  marketplaceItemId: z.uuid(),
  currency: z.string().length(3).optional(),
  price: decimalString.optional(),
  shippingPrice: decimalString.optional(),
  quantityAvailable: z.number().int().nonnegative().optional(),
  quantitySold: z.number().int().nonnegative().optional(),
  availability: z.string().min(1).optional(),
  listingState: z.string().min(1).optional(),
  watchCount: z.number().int().nonnegative().optional(),
  sellerFeedbackScore: z.number().int().optional(),
  sellerFeedbackPct: decimalString.optional(),
  listingEndsAt: z.date().optional(),
  rawStateHash: z.string().min(1).optional(),
});

export const observationBatchSchema = z.strictObject({
  /** Minted by the FETCH, not by this writer; stable across retries. */
  observationBatchId: z.uuid(),
  /** Fixed when the provider result was obtained; stable across retries. */
  observedAt: z.date(),
  connectionId: z.uuid().optional(),
  source: z.string().min(1),
  items: z.array(observationItemSchema),
});

export type ObservationItemInput = z.input<typeof observationItemSchema>;
export type ObservationBatchInput = z.input<typeof observationBatchSchema>;

export type ObservationRow =
  typeof marketplaceItemObservations.$inferSelect;

/**
 * Write one observation batch. Returns the number of rows actually inserted
 * (0 when the whole batch was already recorded — retry-safe by
 * construction).
 */
export async function recordObservationBatch(options: {
  db: LoxepDb;
  batch: ObservationBatchInput;
}): Promise<{ inserted: number }> {
  const { db } = options;
  const batch = observationBatchSchema.parse(options.batch);
  if (batch.items.length === 0) {
    return { inserted: 0 };
  }
  const rows = batch.items.map((item) => ({
    marketplaceItemId: item.marketplaceItemId,
    observedAt: batch.observedAt,
    observationBatchId: batch.observationBatchId,
    connectionId: batch.connectionId ?? null,
    source: batch.source,
    // Absent metrics stay NULL, never 0.
    currency: item.currency ?? null,
    price: item.price ?? null,
    shippingPrice: item.shippingPrice ?? null,
    quantityAvailable: item.quantityAvailable ?? null,
    quantitySold: item.quantitySold ?? null,
    availability: item.availability ?? null,
    listingState: item.listingState ?? null,
    watchCount: item.watchCount ?? null,
    sellerFeedbackScore: item.sellerFeedbackScore ?? null,
    sellerFeedbackPct: item.sellerFeedbackPct ?? null,
    listingEndsAt: item.listingEndsAt ?? null,
    rawStateHash: item.rawStateHash ?? null,
  }));
  const inserted = await db
    .insert(marketplaceItemObservations)
    .values(rows)
    .onConflictDoNothing({
      target: [
        marketplaceItemObservations.observationBatchId,
        marketplaceItemObservations.marketplaceItemId,
        marketplaceItemObservations.observedAt,
      ],
    })
    .returning({
      marketplaceItemId: marketplaceItemObservations.marketplaceItemId,
    });
  return { inserted: inserted.length };
}

/** Latest `n` observations for one item, newest first (hypertable read). */
export async function latestObservations(
  db: LoxepDb,
  marketplaceItemId: string,
  n: number,
): Promise<ObservationRow[]> {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new MarketValidationError("expected a positive integer limit");
  }
  return db.query.marketplaceItemObservations.findMany({
    where: (table, { eq }) => eq(table.marketplaceItemId, marketplaceItemId),
    orderBy: (table, { desc }) => [desc(table.observedAt)],
    limit: n,
  });
}

export const marketplaceItemInputSchema = z.strictObject({
  provider: z.string().min(1),
  marketplace: z.string().min(1),
  externalItemId: z.string().min(1),
  /** When this identity was seen by the current fetch (batch `observedAt`). */
  seenAt: z.date(),
  currentState: z.string().min(1).default("active"),
  sellerExternalId: z.string().min(1).optional(),
  canonicalUrl: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  conditionCode: z.string().min(1).optional(),
  categoryExternalId: z.string().min(1).optional(),
  listingType: z.string().min(1).optional(),
  listingStartedAt: z.date().optional(),
  listingEndsAt: z.date().optional(),
});

export type MarketplaceItemInput = z.input<typeof marketplaceItemInputSchema>;

export interface MarketplaceItemRecord {
  id: string;
  provider: string;
  marketplace: string;
  externalItemId: string;
  sellerExternalId: string | null;
  canonicalUrl: string | null;
  title: string | null;
  conditionCode: string | null;
  categoryExternalId: string | null;
  listingType: string | null;
  listingStartedAt: Date | null;
  listingEndsAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  currentState: string;
  createdAt: Date;
  updatedAt: Date;
}

function textOrNull(value: string | undefined): string {
  return value === undefined ? "null" : textLiteral(value);
}

function timestamptzOrNull(value: Date | undefined): string {
  return value === undefined ? "null" : timestamptzLiteral(value);
}

/**
 * Upsert the canonical `(provider, marketplace, external_item_id)` identity.
 *
 * First-seen/last-seen maintenance is monotonic and retry-safe:
 * `first_seen_at = least(existing, seenAt)`, `last_seen_at =
 * greatest(existing, seenAt)`, so replaying an old batch never regresses
 * either bound. Descriptive fields are NULL-preserving: an absent value
 * keeps whatever is already stored (`coalesce(excluded.x, existing.x)`).
 */
export async function upsertMarketplaceItem(options: {
  db: LoxepDb;
  item: MarketplaceItemInput;
}): Promise<MarketplaceItemRecord> {
  const { db } = options;
  const item = marketplaceItemInputSchema.parse(options.item);
  const seenAt = timestamptzLiteral(item.seenAt);
  const result = await db.execute(
    `insert into marketplace_items (
        provider, marketplace, external_item_id, seller_external_id,
        canonical_url, title, condition_code, category_external_id,
        listing_type, listing_started_at, listing_ends_at,
        first_seen_at, last_seen_at, current_state
      ) values (
        ${textLiteral(item.provider)}, ${textLiteral(item.marketplace)},
        ${textLiteral(item.externalItemId)}, ${textOrNull(item.sellerExternalId)},
        ${textOrNull(item.canonicalUrl)}, ${textOrNull(item.title)},
        ${textOrNull(item.conditionCode)}, ${textOrNull(item.categoryExternalId)},
        ${textOrNull(item.listingType)}, ${timestamptzOrNull(item.listingStartedAt)},
        ${timestamptzOrNull(item.listingEndsAt)},
        ${seenAt}, ${seenAt}, ${textLiteral(item.currentState)}
      )
      on conflict (provider, marketplace, external_item_id) do update set
        seller_external_id = coalesce(excluded.seller_external_id, marketplace_items.seller_external_id),
        canonical_url = coalesce(excluded.canonical_url, marketplace_items.canonical_url),
        title = coalesce(excluded.title, marketplace_items.title),
        condition_code = coalesce(excluded.condition_code, marketplace_items.condition_code),
        category_external_id = coalesce(excluded.category_external_id, marketplace_items.category_external_id),
        listing_type = coalesce(excluded.listing_type, marketplace_items.listing_type),
        listing_started_at = coalesce(excluded.listing_started_at, marketplace_items.listing_started_at),
        listing_ends_at = coalesce(excluded.listing_ends_at, marketplace_items.listing_ends_at),
        first_seen_at = least(marketplace_items.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(marketplace_items.last_seen_at, excluded.last_seen_at),
        current_state = excluded.current_state,
        updated_at = now()
      returning id`,
  );
  const inserted = result.rows[0];
  if (inserted === undefined) {
    throw new MarketNotFoundError("marketplace item upsert returned no row");
  }
  const row = await db.query.marketplaceItems.findFirst({
    where: (table, { eq }) => eq(table.id, inserted["id"] as string),
  });
  if (row === undefined) {
    throw new MarketNotFoundError("marketplace item vanished after upsert");
  }
  return row;
}

/**
 * Maintain the `monitor_items` discovery link: first insert records
 * `first_discovered_at`; re-linking bumps `last_matched_at` monotonically
 * and reactivates the link. Idempotent under retries.
 */
export async function linkItemToMonitor(
  db: LoxepDb,
  options: { monitorTargetId: string; marketplaceItemId: string; at?: Date },
): Promise<void> {
  const at = timestamptzLiteral(options.at ?? new Date());
  await db.execute(
    `insert into monitor_items (
        monitor_target_id, marketplace_item_id,
        first_discovered_at, last_matched_at, active
      ) values (
        ${uuidLiteral(options.monitorTargetId)},
        ${uuidLiteral(options.marketplaceItemId)},
        ${at}, ${at}, true
      )
      on conflict (monitor_target_id, marketplace_item_id) do update set
        last_matched_at = greatest(monitor_items.last_matched_at, excluded.last_matched_at),
        active = true`,
  );
}
