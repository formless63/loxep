-- loxep-bub: typed multi-address model for hosting targets.
--
-- `host_addresses` replaces `hosting_targets.address_v4`/`address_v6` — the
-- single pair that meant exactly one thing, "the DNS-publishable WAN
-- address" — with a typed, multi-row model (kind wan/lan/tailnet/other,
-- family v4/v6, provenance operator_declared/observed:<provider>,
-- primary-per-kind-and-family). Every existing address_v4/address_v6 value
-- is BACKFILLED into a kind='wan', provenance='operator_declared',
-- is_primary=true row before the two columns are dropped — pre-release, a
-- clean cut, per loxep-bub's own instruction. See
-- packages/db/src/schema/infrastructure.ts's `hostAddresses` doc comment for
-- the full rationale, including how `hosting_targets_addressable_check`
-- (dropped below, since a CHECK cannot query another table) is re-expressed
-- as a service-level invariant in @loxep/infrastructure.
CREATE TABLE "host_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hosting_target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"family" text NOT NULL,
	"value" "inet" NOT NULL,
	"provenance" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"observed_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_addresses_kind_family_value_uq" UNIQUE("hosting_target_id","kind","family","value"),
	CONSTRAINT "host_addresses_kind_check" CHECK ("host_addresses"."kind" in ('wan', 'lan', 'tailnet', 'other')),
	CONSTRAINT "host_addresses_family_check" CHECK ("host_addresses"."family" in ('v4', 'v6')),
	CONSTRAINT "host_addresses_family_matches_value_check" CHECK (("host_addresses"."family" = 'v4' and family("host_addresses"."value") = 4) or ("host_addresses"."family" = 'v6' and family("host_addresses"."value") = 6)),
	CONSTRAINT "host_addresses_provenance_check" CHECK ("host_addresses"."provenance" = 'operator_declared' or "host_addresses"."provenance" like 'observed:%'),
	CONSTRAINT "host_addresses_observed_at_check" CHECK (("host_addresses"."provenance" <> 'operator_declared') = ("host_addresses"."observed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "hosting_targets" DROP CONSTRAINT "hosting_targets_addressable_check";--> statement-breakpoint
ALTER TABLE "host_addresses" ADD CONSTRAINT "host_addresses_hosting_target_id_hosting_targets_id_fk" FOREIGN KEY ("hosting_target_id") REFERENCES "public"."hosting_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_addresses" ADD CONSTRAINT "host_addresses_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "host_addresses_observed_slot_uq" ON "host_addresses" USING btree ("hosting_target_id","kind","family","provenance") WHERE "host_addresses"."provenance" <> 'operator_declared';--> statement-breakpoint
CREATE UNIQUE INDEX "host_addresses_primary_uq" ON "host_addresses" USING btree ("hosting_target_id","kind","family") WHERE "host_addresses"."is_primary";--> statement-breakpoint
CREATE INDEX "host_addresses_hosting_target_id_idx" ON "host_addresses" USING btree ("hosting_target_id");--> statement-breakpoint
CREATE INDEX "host_addresses_wan_declared_idx" ON "host_addresses" USING btree ("hosting_target_id") WHERE "host_addresses"."kind" = 'wan' and "host_addresses"."provenance" = 'operator_declared';--> statement-breakpoint
-- Backfill: every existing address_v4/address_v6 value becomes a wan,
-- operator_declared, primary host_addresses row, timestamped from the
-- hosting_targets row it came from (not "now") — the value did not just
-- become true.
INSERT INTO "host_addresses" ("hosting_target_id", "kind", "family", "value", "provenance", "is_primary", "created_at", "updated_at")
SELECT "id", 'wan', 'v4', "address_v4", 'operator_declared', true, "created_at", "updated_at"
FROM "hosting_targets"
WHERE "address_v4" IS NOT NULL;--> statement-breakpoint
INSERT INTO "host_addresses" ("hosting_target_id", "kind", "family", "value", "provenance", "is_primary", "created_at", "updated_at")
SELECT "id", 'wan', 'v6', "address_v6", 'operator_declared', true, "created_at", "updated_at"
FROM "hosting_targets"
WHERE "address_v6" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "hosting_targets" DROP COLUMN "address_v4";--> statement-breakpoint
ALTER TABLE "hosting_targets" DROP COLUMN "address_v6";
