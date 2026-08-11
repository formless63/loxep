-- Foundation defect repair (loxep-dyx): `media_links` and `resource_links`
-- shipped in 0000 with no primary key, no unique constraint, and no index.
--
-- ## The defect
--
-- Jobs are at-least-once and handlers must be idempotent (implementation
-- contract). With no unique constraint there is no `ON CONFLICT` target, so a
-- retried attachment job inserts a second identical row: a gallery renders the
-- same photo twice, and an "unlink" that deletes by natural key silently
-- removes both copies or neither. With no index, "what is attached to this
-- acquisition?" is a sequential scan of every link in the installation.
--
-- ## The chosen keys, per foundation-schema.md's "based on actual attachment
-- ## semantics rather than one universal relationship rule"
--
-- ```text
-- media_links     unique(media_object_id, resource_type, resource_id, purpose)
-- resource_links  unique(external_resource_id, resource_type, resource_id, purpose)
-- ```
--
-- The semantics that actually hold across every resource type are: one object
-- attaches to many resources (a receipt photo covers a lot AND each item
-- unpacked from it), one resource holds many objects (twelve condition photos
-- on one item), and one (object, resource, purpose) triple is ONE fact that
-- gains nothing from being asserted twice.
--
--   * `purpose` is IN the key. The same photo legitimately serves as both
--     `gallery` and `condition_evidence` for one item, and the same tracker
--     ticket as both `spec` and `discussion` for one acquisition. Those are two
--     facts, not a duplicate.
--   * `media_links.sort_order` is deliberately NOT in the key. Sort order is
--     presentation; including it would let the same photo attach to the same
--     item twice by being dragged to a different position — precisely the
--     duplicate this constraint exists to prevent.
--   * Every keyed column is `not null`, so the natural key is total. Unlike
--     `channel_listings` (0003) this needs no `NULLS NOT DISTINCT`.
--   * No surrogate `uuid` primary key is added. The natural key is complete and
--     stable, and a synthetic id on a pure junction row would exist only to be
--     ignored — deletion is already by natural key.
--
-- ## Indexes, both directions
--
-- The unique index serves object → resources on its leading column
-- (`media_object_id` / `external_resource_id`), and the new
-- `(resource_type, resource_id)` index serves resource → objects, which is the
-- hot direction: every item, acquisition, and shipment detail view. A third
-- index on the leading column alone would only duplicate the unique's prefix,
-- so there is not one — one index per named query, not defensive indexing.
--
-- ## Pre-existing duplicates
--
-- No consumer of either table has shipped yet, so these DELETEs are expected to
-- remove zero rows. They run anyway because a constraint added to a table that
-- might hold duplicates must state how it resolves them rather than failing the
-- migration: the earliest `created_at` wins (`ctid` breaks a tie), which keeps
-- the original attachment and its `sort_order`.
DELETE FROM "media_links" a
      USING "media_links" b
      WHERE a."media_object_id" = b."media_object_id"
        AND a."resource_type" = b."resource_type"
        AND a."resource_id" = b."resource_id"
        AND a."purpose" = b."purpose"
        AND (a."created_at", a.ctid) > (b."created_at", b.ctid);--> statement-breakpoint
DELETE FROM "resource_links" a
      USING "resource_links" b
      WHERE a."external_resource_id" = b."external_resource_id"
        AND a."resource_type" = b."resource_type"
        AND a."resource_id" = b."resource_id"
        AND a."purpose" = b."purpose"
        AND (a."created_at", a.ctid) > (b."created_at", b.ctid);--> statement-breakpoint
CREATE INDEX "media_links_resource_idx" ON "media_links" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "resource_links_resource_idx" ON "resource_links" USING btree ("resource_type","resource_id");--> statement-breakpoint
ALTER TABLE "media_links" ADD CONSTRAINT "media_links_object_resource_purpose_uq" UNIQUE("media_object_id","resource_type","resource_id","purpose");--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_resource_purpose_uq" UNIQUE("external_resource_id","resource_type","resource_id","purpose");
