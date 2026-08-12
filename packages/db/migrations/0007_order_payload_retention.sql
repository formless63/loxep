-- ADR-0021 order-payload retention: one nullable column and one partial index.
--
-- Order-class `provider_objects` payloads are the only retained provider
-- objects that carry buyer personal data (billing/shipping addresses, email,
-- phone, customer IP and user agent on WooCommerce; additionally a taxpayer id
-- and gift-recipient details on eBay). ADR-0021 refines foundational decision
-- 7 for that class alone: the payload is REDACTED IN PLACE after a
-- configurable window (180-day default, `commerce.order_payload_retention`),
-- and the provenance row is never automatically deleted.
--
--   redacted_at   when the sweep replaced `payload` with its redacted form;
--                 null means the payload is still verbatim.
--   the index     the sweep's exact predicate — order-class object types,
--                 oldest first, not yet redacted. Partial on
--                 `redacted_at is null` so it shrinks back toward empty as the
--                 sweep catches up instead of growing with the table.
--
-- ## What this migration deliberately does NOT do
--
--   backfill / redact anything          the sweep job does that, bounded per
--                                       run and gated on the setting; a
--                                       migration must not rewrite payloads.
--   touch order_source_links            links reference the provenance row,
--                                       which persists through redaction, so
--                                       nothing dangles and nothing changes.
--   add a hard-delete path              ADR-0021 has no automatic delete mode;
--                                       hard deletion stays an explicit
--                                       operator action.
--   recompute payload_hash              see the column comment below — this is
--                                       the load-bearing part of the design.
ALTER TABLE "provider_objects" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "provider_objects_redaction_sweep_idx" ON "provider_objects" USING btree ("object_type","fetched_at") WHERE "provider_objects"."redacted_at" is null;--> statement-breakpoint
COMMENT ON COLUMN "provider_objects"."redacted_at" IS
  'ADR-0021: when the order-payload retention sweep replaced payload with its provider-specific redacted form; null means the payload is still verbatim. payload_hash keeps identifying the ORIGINAL payload and is NEVER recomputed on redaction, so after a sweep the stored payload no longer hashes to payload_hash. That is deliberate: ingestion dedups an unchanged re-sync by comparing the incoming payload hash to this row''s, so rehashing would make every re-sync of an old order look changed and store a fresh copy of the personal data the sweep just removed. Only order-class object types are swept; every other class keeps foundational decision 7 retain-by-default and leaves this null.';
