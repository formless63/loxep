-- Storage-backend default invariants.
--
-- Existing installations predate database enforcement. Repair any disabled
-- default first, then deterministically retain the oldest enabled default if
-- a racing/service-level writer previously left more than one behind. Zero
-- defaults remains valid while an installation is being configured.
UPDATE "storage_backends"
SET "is_default" = false, "updated_at" = now()
WHERE "is_default" AND NOT "enabled";--> statement-breakpoint
WITH "ranked_defaults" AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "default_rank"
	FROM "storage_backends"
	WHERE "is_default"
)
UPDATE "storage_backends" AS "backend"
SET "is_default" = false, "updated_at" = now()
FROM "ranked_defaults" AS "ranked"
WHERE "backend"."id" = "ranked"."id" AND "ranked"."default_rank" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_backends_default_uq" ON "storage_backends" USING btree ("is_default") WHERE "storage_backends"."is_default";--> statement-breakpoint
ALTER TABLE "storage_backends" ADD CONSTRAINT "storage_backends_default_enabled_check" CHECK (not "storage_backends"."is_default" or "storage_backends"."enabled");
