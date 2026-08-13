-- Flipping M6 (loxep-dgf.6): manual/offline channel listings and the
-- inventory-to-draft bridge.
--
-- Design: flipping-lifecycle-design.md section 4. Two OWNER-REVIEW-CRITICAL
-- open questions gated this migration; both are resolved here under an
-- explicit owner directive to implement each per the design's own
-- recommendation and mark it PROVISIONAL for review (see the PROVISIONAL
-- DECISIONS block atop packages/db/src/schema/commerce.ts for the summary,
-- and packages/db/src/schema/commerce.ts's inline comments for the detail at
-- each column/constraint):
--
--   OQ5  channel_listings does NOT gain an inventory_item_id. A catalog item
--        is minted at listing time instead. Zero schema consequence here —
--        catalog_items and its unique(sku) are unchanged.
--   OQ7  orders.connection_id becomes nullable, mirroring exactly what this
--        migration does to channel_listings.connection_id, so a manual/
--        offline listing can record its own sale.
--
-- Steps 1-3 are the three-step nullable-backfill-notnull dance for the new
-- channel_listings.listing_code column and MUST stay three separate
-- statements — there is no safe single-statement form when the table may
-- already hold rows. Steps 4-8 are ONE migration (this file) because between
-- dropping channel_listings.connection_id's NOT NULL and adding
-- channel_listings_manual_connection_check there is a window in which a
-- connection-less non-manual row is insertable; the same reasoning applies
-- to orders.connection_id and orders_manual_connection_check.
--
-- Hand-written throughout: `drizzle-kit generate` produces everything below
-- EXCEPT the `NULLS NOT DISTINCT` clause on the partial
-- channel_listings_connection_listing_variation_uq index (step 6) and the
-- listing_code backfill (step 2) — Drizzle Kit as of drizzle-orm@0.45.2 has
-- no way to express NULLS NOT DISTINCT together with a partial WHERE
-- (`IndexBuilder`, what `uniqueIndex()` returns, has no
-- `.nullsNotDistinct()` method; only the non-partial `unique()` builder does)
-- and does not synthesize data backfills. Per the design's own instruction
-- ("verify current Drizzle Kit capability at implementation time and fall
-- back to hand-written SQL rather than weakening any constraint"), this file
-- is hand-written rather than drizzle-kit's raw output, so both survive
-- intact. `packages/db/src/schema/commerce.ts`'s Drizzle model is the
-- closest diffable shape of this file's DDL and must not drift from it.

-- 1. Add listing_code nullable first — the table may already hold rows.
ALTER TABLE "channel_listings" ADD COLUMN "listing_code" text;--> statement-breakpoint

-- 2. Backfill. The design notes "there are almost none" — channel_listings
--    has shipped since Phase 3 with zero runtime writers (see the design's
--    Contradiction 5) — so any deterministic, unique scheme is sufficient.
--    Ordered by first_ingested_at so an operator's rows get low sequence
--    numbers in creation order, exactly like a real listing_code would.
WITH "numbered" AS (
  SELECT "id",
         extract(year FROM "first_ingested_at")::int AS "year",
         row_number() OVER (
           PARTITION BY extract(year FROM "first_ingested_at")
           ORDER BY "first_ingested_at", "id"
         ) AS "seq"
    FROM "channel_listings"
)
UPDATE "channel_listings" AS "cl"
   SET "listing_code" = 'LST-' || "numbered"."year" || '-' || lpad("numbered"."seq"::text, 4, '0')
  FROM "numbered"
 WHERE "cl"."id" = "numbered"."id";--> statement-breakpoint

-- 3. Close the dance: NOT NULL, then the identity constraint.
ALTER TABLE "channel_listings" ALTER COLUMN "listing_code" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_listing_code_uq" UNIQUE("listing_code");--> statement-breakpoint

-- 4. Relax the two NOT NULLs the manual/draft shape needs.
ALTER TABLE "channel_listings" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_listings" ALTER COLUMN "external_listing_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "connection_id" DROP NOT NULL;--> statement-breakpoint

-- 5. Drop the two constraints being widened.
ALTER TABLE "channel_listings" DROP CONSTRAINT "channel_listings_connection_listing_variation_uq";--> statement-breakpoint
ALTER TABLE "orders" DROP CONSTRAINT "orders_connection_provider_external_order_uq";--> statement-breakpoint

-- 6. Recreate channel_listings' identity as a PARTIAL unique index. NULLS NOT
--    DISTINCT is preserved (the original reason still holds: a non-variant
--    listing's null external_variation_id must not make every re-sync insert
--    a duplicate) and the WHERE clause is what lets a manual/draft row
--    (external_listing_id null) coexist without colliding.
CREATE UNIQUE INDEX "channel_listings_connection_listing_variation_uq" ON "channel_listings" USING btree ("connection_id","provider","external_listing_id","external_variation_id") NULLS NOT DISTINCT WHERE "channel_listings"."external_listing_id" is not null;--> statement-breakpoint

-- 7. Recreate orders' identity with NULLS NOT DISTINCT. No partial WHERE is
--    needed here (unlike step 6): external_order_id stays NOT NULL for every
--    row, manual included, so the plain three-column tuple is always fully
--    populated.
ALTER TABLE "orders" ADD CONSTRAINT "orders_connection_provider_external_order_uq" UNIQUE NULLS NOT DISTINCT("connection_id","provider","external_order_id");--> statement-breakpoint

-- 8. The kind/reference consistency CHECKs, applied to both tables in the
--    same migration that dropped their NOT NULLs — see the file header.
ALTER TABLE "channel_listings" ADD CONSTRAINT "channel_listings_manual_connection_check" CHECK (("channel_listings"."provider" = 'manual') = ("channel_listings"."connection_id" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_manual_connection_check" CHECK (("orders"."provider" = 'manual') = ("orders"."connection_id" is null));
