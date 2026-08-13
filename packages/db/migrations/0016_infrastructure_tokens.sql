-- Phase 7 Infrastructure control plane, milestone 3 — the token pair
-- (loxep-lmy.3).
--
-- From apps/docs/src/content/docs/architecture/infrastructure-control-design.md:
-- the LAST two tables the design's "Migration plan sketch" ordering assigns,
-- step 8 — the twelfth and final table of the design, closing it out:
--
--   dns_provider_tokens        a narrow per-host DNS-edit credential Loxep
--                               MINTS (never one it authenticates with)
--   dns_provider_token_zones   the zone-scope INTENT for a minted token; a
--                               provider "update policy" call replaces the
--                               whole array, so this table is rebuilt from,
--                               never mirrored into
--
-- No existing table gains a COLUMN — still the design's rule, still held.
-- `hosting_targets.proxy_connection_id` was already usable as of migration
-- 0012; nothing here alters it. There is no `economic_entity_id` anywhere
-- (ADR-0017), no money column, and no hypertable: a minted token is a
-- statement of intent plus a reference to its secret, not a temporal sample.
--
-- ## The value is returned EXACTLY ONCE — a transaction property, not a
-- schema one
--
-- `dns_provider_tokens.secret_id` is nullable so the row can be inserted
-- before the provider call returns the plaintext, but `@loxep/infrastructure`
-- must capture that plaintext into `application_secrets` in the SAME
-- transaction that writes this row, or it is unrecoverable. ADR-0022 governs
-- what a human ever sees of it: reveal-once, in the response to a
-- request-scoped admin mint action — never a worker job, which is the gap
-- milestone 2 found (`mailboxes.secret_id`'s mint has no such response) and
-- named explicitly for this milestone to avoid.
--
-- ## `permission_scope` is a LOXEP-owned label, not a stored provider scope
--
-- One value today (`dns_edit`); provider permission-group identifiers stay in
-- the adapter, the same reason provider filter grammar never appears in a
-- `monitor_targets` config. Widening the CHECK is the appropriate ceremony
-- for changing what a live host credential may edit.
--
-- ## No `created_by_user_id` on `dns_provider_tokens`, deliberately
--
-- The design's inherited-conventions section names exactly two tables in this
-- schema needing an ADR-0020 user reference: `managed_domains` and
-- `hosting_targets`. This is not one of them — who minted a token is
-- `audit_events`' fact, not a column that would duplicate it.
CREATE TABLE "dns_provider_token_zones" (
	"token_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	CONSTRAINT "dns_provider_token_zones_token_id_domain_id_pk" PRIMARY KEY("token_id","domain_id")
);
--> statement-breakpoint
CREATE TABLE "dns_provider_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hosting_target_id" uuid NOT NULL,
	"dns_connection_id" uuid NOT NULL,
	"external_token_id" text NOT NULL,
	"name" text NOT NULL,
	"permission_scope" text NOT NULL,
	"secret_id" uuid,
	"policy_synced_at" timestamp with time zone,
	"last_rolled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_provider_tokens_connection_external_token_uq" UNIQUE("dns_connection_id","external_token_id"),
	CONSTRAINT "dns_provider_tokens_permission_scope_check" CHECK ("dns_provider_tokens"."permission_scope" in ('dns_edit'))
);
--> statement-breakpoint
ALTER TABLE "dns_provider_token_zones" ADD CONSTRAINT "dns_provider_token_zones_token_fk" FOREIGN KEY ("token_id") REFERENCES "public"."dns_provider_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_token_zones" ADD CONSTRAINT "dns_provider_token_zones_domain_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_tokens" ADD CONSTRAINT "dns_provider_tokens_hosting_target_id_hosting_targets_id_fk" FOREIGN KEY ("hosting_target_id") REFERENCES "public"."hosting_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_tokens" ADD CONSTRAINT "dns_provider_tokens_dns_connection_id_connections_id_fk" FOREIGN KEY ("dns_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_tokens" ADD CONSTRAINT "dns_provider_tokens_secret_id_application_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."application_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_provider_tokens_hosting_target_id_idx" ON "dns_provider_tokens" USING btree ("hosting_target_id");