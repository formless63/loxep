/**
 * `marketplace_item_observations` — TimescaleDB hypertable.
 *
 * IMPORTANT: this table is defined here ONLY for Drizzle typing/query
 * building. It is deliberately excluded from drizzle-kit generation
 * (see drizzle.config.ts) because the table is created by a hand-written SQL
 * migration as a hypertable:
 *   - partitioned by `observed_at`, 7-day chunks;
 *   - unique (observation_batch_id, marketplace_item_id, observed_at) for
 *     retry identity under at-least-once job execution;
 *   - columnstore policy after ~30 days; no retention policy.
 *
 * There are intentionally no FK constraints on the hypertable, matching the
 * foundation schema draft's "logical columns" — `marketplace_item_id` and
 * `connection_id` are provenance references resolved in the application.
 */
import {
  bigint,
  char,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const marketplaceItemObservations = pgTable(
  "marketplace_item_observations",
  {
    marketplaceItemId: uuid("marketplace_item_id").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    // Minted once when a provider fetch/poll result is obtained; retained
    // across processing retries (retry identity, foundation-schema.md).
    observationBatchId: uuid("observation_batch_id").notNull(),
    connectionId: uuid("connection_id"),
    source: text("source").notNull(),
    currency: char("currency", { length: 3 }),
    price: numeric("price", { precision: 20, scale: 6 }),
    shippingPrice: numeric("shipping_price", { precision: 20, scale: 6 }),
    quantityAvailable: integer("quantity_available"),
    quantitySold: integer("quantity_sold"),
    availability: text("availability"),
    listingState: text("listing_state"),
    watchCount: integer("watch_count"),
    sellerFeedbackScore: bigint("seller_feedback_score", { mode: "number" }),
    sellerFeedbackPct: numeric("seller_feedback_pct", {
      precision: 10,
      scale: 6,
    }),
    listingEndsAt: timestamp("listing_ends_at", { withTimezone: true }),
    rawStateHash: text("raw_state_hash"),
  },
);
