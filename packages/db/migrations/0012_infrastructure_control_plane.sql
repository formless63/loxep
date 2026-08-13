-- Phase 7 Infrastructure control plane, milestone 1 (loxep-lmy.1).
--
-- From apps/docs/src/content/docs/architecture/infrastructure-control-design.md:
-- SEVEN of that design's twelve tables — its "Migration plan sketch" ordering
-- steps 1, 2, 4, 5, 6, and 7, which the same section says "are milestone 1 and
-- can ship alone":
--
--   hosting_targets        a place a name can point at (the spec's `vps`)
--   managed_domains        one domain name, its provisioning position, intent
--   dns_records            the DESIRED DNS state
--   reconcile_runs         what the reconciler did
--   reconcile_run_steps    step by step, REDACTED
--   dns_drift_findings     the persisted desired-versus-observed output
--   provider_operations    the outbound idempotency ledger
--
-- ## What this migration deliberately does NOT create
--
--   mailbox_templates / mailbox_template_entries   milestone 2 (ordering 3)
--   mail_domains / mailboxes                       milestone 2 (ordering 9)
--   dns_provider_tokens / dns_provider_token_zones milestone 3 (ordering 8)
--
-- ## No existing table gains a column
--
-- The design's own rule, held exactly. connections, application_secrets,
-- monitor_targets, audit_events, economic_entities, and every commercial table
-- are untouched. This domain extends them only through namespaced `config`
-- keys, new `purpose` / `target_type` / `action` text values, and foreign keys
-- pointing INTO them. There is no economic_entity_id anywhere below
-- (ADR-0017), no money column, and no hypertable — a DNS record is a statement
-- of intent, not a temporal sample.
--
-- ## PROVISIONAL decisions (owner directive: "each per its own recommendation")
--
--   OQ2  CAA policy content    the registered setting `infrastructure.caa_policy`
--                              ships with NO default value; the materializer
--                              REFUSES to emit a CAA set until the owner fills
--                              it. No column here. Never ship a guessed issuer
--                              list as a working default.
--   OQ3  unexpected records    NEVER deleted automatically, in any mode. A
--                              service rule; the resolution vocabulary
--                              ('adopted' | 'dismissed' | ...) is the CHECK on
--                              dns_drift_findings.resolution.
--   OQ4  pending operations    resolved by READING the provider back for the
--                              object the operation would have created, never
--                              by a blind retry. A service rule; the ledger's
--                              three-value status is what makes it expressible.
--   OQ5  reconcile cadence     the SHARED scheduling model, so
--                              managed_domains.reconcile_target_id is a real FK
--                              to monitor_targets. No infrastructure-owned
--                              scheduling table and no next_reconcile_at.
--   OQ7  soft-delete uniques   dns_records' natural-key unique covers ALL rows
--                              including tombstones; the materializer
--                              RESURRECTS a soft-deleted row rather than
--                              inserting a second one.
--
-- ## Verified at implementation time, per the design's "Before implementing"
--
--   * drizzle-kit 0.31.10 emits `inet`, PARTIAL unique indexes, a unique index
--     over a `coalesce(...)` EXPRESSION, and multi-column CHECKs correctly.
--     Nothing had to be hand-written and no constraint was weakened.
--   * FK constraint names: every generated name here was measured against
--     PostgreSQL's 63-byte identifier limit. The longest is
--     `hosting_targets_fronted_by_target_id_hosting_targets_id_fk` (59), so no
--     explicit name is forced. The self-reference is named explicitly because
--     Drizzle requires the foreignKey() form for it. The design's two named
--     candidates (dns_provider_token_zones, mailbox_template_entries) are both
--     milestone-2/3 tables.
--   * dns_records_natural_key_uq spans `content`, and a btree index tuple is
--     capped near 2704 bytes. Every record class this design materializes is
--     far inside it (an address, a CAA issuer string, and — milestone 2 — a
--     mail provider's CNAMEs and a DKIM TXT of roughly 400 characters), so the
--     design's hash-expression fallback is NOT needed. Revisit if a future
--     record class can exceed it: the failure would be at INSERT, not at sync.
--
-- ## Two columns that ship ahead of their foreign keys, on purpose
--
--   hosting_targets.proxy_connection_id  milestone-3 territory; the design
--                                        ships it now because "a nullable
--                                        unused column is cheaper than an
--                                        ALTER". Its FK exists (connections
--                                        does).
--   managed_domains.mailbox_template_id  same reasoning, but mailbox_templates
--                                        is a milestone-2 table, so this column
--                                        ships WITHOUT its FK and milestone 2
--                                        adds the constraint. ADD CONSTRAINT
--                                        against an empty relationship is free;
--                                        ADD COLUMN later would not be.
--
--
-- ## One DOCUMENTED DIVERGENCE from the design's sketch: dns_records.owner
--
-- The design lists five owners (apex, wildcard, mail, proxy_resource, manual)
-- and no `caa`, yet its materialization rules say "always: emit the CAA record
-- set from the installation's configured issuance policy". Both cannot hold.
-- A sixth value, `caa`, is added rather than overloading `apex` — which is
-- documented as "materialized from apex_target_id" and would make the
-- reconciler delete a domain's CAA policy whenever an operator cleared an
-- unrelated apex target, on a mail-only domain that never had one. Widening a
-- CHECK before any row exists is a one-word edit; discovering the overload
-- later is a migration plus a data repair. Recorded in the design document's
-- implementation-status header.
--
CREATE TABLE "dns_drift_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"dns_record_id" uuid,
	"kind" text NOT NULL,
	"record_type" text NOT NULL,
	"record_name" text NOT NULL,
	"desired_content" text,
	"observed_content" text,
	"desired_proxied" boolean,
	"observed_proxied" boolean,
	"external_record_id" text,
	"first_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"resolved_by_user_id" text,
	"first_seen_run_id" uuid NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	CONSTRAINT "dns_drift_findings_kind_check" CHECK ("dns_drift_findings"."kind" in ('missing', 'modified', 'unexpected')),
	CONSTRAINT "dns_drift_findings_resolution_check" CHECK ("dns_drift_findings"."resolution" is null or "dns_drift_findings"."resolution" in ('applied', 'adopted', 'dismissed', 'disappeared')),
	CONSTRAINT "dns_drift_findings_resolution_pair_check" CHECK (("dns_drift_findings"."resolved_at" is null) = ("dns_drift_findings"."resolution" is null)),
	CONSTRAINT "dns_drift_findings_unexpected_record_check" CHECK (("dns_drift_findings"."kind" = 'unexpected') = ("dns_drift_findings"."dns_record_id" is null))
);
--> statement-breakpoint
CREATE TABLE "dns_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"priority" integer,
	"ttl_seconds" integer,
	"proxied" boolean DEFAULT false NOT NULL,
	"owner" text NOT NULL,
	"external_record_id" text,
	"last_synced_at" timestamp with time zone,
	"desired_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_records_natural_key_uq" UNIQUE("domain_id","type","name","content"),
	CONSTRAINT "dns_records_owner_check" CHECK ("dns_records"."owner" in ('apex', 'wildcard', 'caa', 'mail', 'proxy_resource', 'manual')),
	CONSTRAINT "dns_records_mail_not_proxied_check" CHECK (not ("dns_records"."owner" = 'mail' and "dns_records"."proxied")),
	CONSTRAINT "dns_records_ttl_seconds_check" CHECK ("dns_records"."ttl_seconds" is null or "dns_records"."ttl_seconds" between 30 and 604800)
);
--> statement-breakpoint
CREATE TABLE "hosting_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"control_surface" text NOT NULL,
	"provider" text,
	"region" text,
	"address_v4" "inet",
	"address_v6" "inet",
	"fronted_by_target_id" uuid,
	"proxy_connection_id" uuid,
	"external_site_id" text,
	"notes" text,
	"decommissioned_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosting_targets_name_uq" UNIQUE("name"),
	CONSTRAINT "hosting_targets_control_surface_check" CHECK ("hosting_targets"."control_surface" in ('proxy_node', 'tunnel_client', 'direct_reverse_proxy', 'none')),
	CONSTRAINT "hosting_targets_no_self_front_check" CHECK ("hosting_targets"."fronted_by_target_id" is distinct from "hosting_targets"."id"),
	CONSTRAINT "hosting_targets_tunnel_client_check" CHECK (("hosting_targets"."control_surface" = 'tunnel_client') = ("hosting_targets"."fronted_by_target_id" is not null)),
	CONSTRAINT "hosting_targets_addressable_check" CHECK ("hosting_targets"."control_surface" = 'none' or "hosting_targets"."address_v4" is not null or "hosting_targets"."address_v6" is not null or "hosting_targets"."fronted_by_target_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "managed_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"dns_connection_id" uuid NOT NULL,
	"registrar" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"external_zone_id" text,
	"zone_nameservers" text[],
	"provider_zone_status" text,
	"delegation_verified_at" timestamp with time zone,
	"apex_target_id" uuid,
	"apex_proxied" boolean DEFAULT true NOT NULL,
	"wildcard_proxied" boolean DEFAULT true NOT NULL,
	"mail_enabled" boolean DEFAULT true NOT NULL,
	"mailbox_template_id" uuid,
	"reconcile_target_id" uuid,
	"last_reconciled_at" timestamp with time zone,
	"drift_detected_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_domains_name_uq" UNIQUE("name"),
	CONSTRAINT "managed_domains_state_check" CHECK ("managed_domains"."state" in ('draft', 'zone_created', 'awaiting_delegation', 'zone_active', 'records_synced', 'mail_pending', 'ready')),
	CONSTRAINT "managed_domains_consecutive_errors_check" CHECK ("managed_domains"."consecutive_errors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_operations" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"operation" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"response_summary" jsonb,
	"attempts" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "provider_operations_status_check" CHECK ("provider_operations"."status" in ('pending', 'succeeded', 'failed')),
	CONSTRAINT "provider_operations_attempts_check" CHECK ("provider_operations"."attempts" >= 1),
	CONSTRAINT "provider_operations_completed_at_check" CHECK (("provider_operations"."status" = 'pending') = ("provider_operations"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "reconcile_run_steps" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"step" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"request_summary" jsonb,
	"response_summary" jsonb,
	"error_code" text,
	"error_detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconcile_run_steps_run_sequence_uq" UNIQUE("run_id","sequence"),
	CONSTRAINT "reconcile_run_steps_sequence_check" CHECK ("reconcile_run_steps"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reconcile_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"trigger" text NOT NULL,
	"actor_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"step_count" integer DEFAULT 0 NOT NULL,
	"error_summary" text,
	CONSTRAINT "reconcile_runs_mode_check" CHECK ("reconcile_runs"."mode" in ('apply', 'check')),
	CONSTRAINT "reconcile_runs_status_check" CHECK ("reconcile_runs"."status" in ('running', 'succeeded', 'failed', 'partial')),
	CONSTRAINT "reconcile_runs_subject_type_check" CHECK ("reconcile_runs"."subject_type" in ('domain', 'hosting_target', 'token')),
	CONSTRAINT "reconcile_runs_trigger_check" CHECK ("reconcile_runs"."trigger" in ('intent_change', 'sweep', 'manual', 'poll'))
);
--> statement-breakpoint
ALTER TABLE "dns_drift_findings" ADD CONSTRAINT "dns_drift_findings_domain_id_managed_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_drift_findings" ADD CONSTRAINT "dns_drift_findings_dns_record_id_dns_records_id_fk" FOREIGN KEY ("dns_record_id") REFERENCES "public"."dns_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_drift_findings" ADD CONSTRAINT "dns_drift_findings_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_drift_findings" ADD CONSTRAINT "dns_drift_findings_first_seen_run_id_reconcile_runs_id_fk" FOREIGN KEY ("first_seen_run_id") REFERENCES "public"."reconcile_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_drift_findings" ADD CONSTRAINT "dns_drift_findings_last_seen_run_id_reconcile_runs_id_fk" FOREIGN KEY ("last_seen_run_id") REFERENCES "public"."reconcile_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_domain_id_managed_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_proxy_connection_id_connections_id_fk" FOREIGN KEY ("proxy_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_targets" ADD CONSTRAINT "hosting_targets_fronted_by_target_fk" FOREIGN KEY ("fronted_by_target_id") REFERENCES "public"."hosting_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_dns_connection_id_connections_id_fk" FOREIGN KEY ("dns_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_apex_target_id_hosting_targets_id_fk" FOREIGN KEY ("apex_target_id") REFERENCES "public"."hosting_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_reconcile_target_id_monitor_targets_id_fk" FOREIGN KEY ("reconcile_target_id") REFERENCES "public"."monitor_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_run_id_reconcile_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconcile_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconcile_run_steps" ADD CONSTRAINT "reconcile_run_steps_run_id_reconcile_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconcile_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconcile_runs" ADD CONSTRAINT "reconcile_runs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dns_drift_findings_unresolved_uq" ON "dns_drift_findings" USING btree ("domain_id","kind","record_type","record_name",coalesce("observed_content", '')) WHERE "dns_drift_findings"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "dns_drift_findings_domain_unresolved_idx" ON "dns_drift_findings" USING btree ("domain_id") WHERE "dns_drift_findings"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "dns_records_domain_id_live_idx" ON "dns_records" USING btree ("domain_id") WHERE "dns_records"."desired_deleted_at" is null;--> statement-breakpoint
CREATE INDEX "hosting_targets_fronted_by_target_id_idx" ON "hosting_targets" USING btree ("fronted_by_target_id") WHERE "hosting_targets"."fronted_by_target_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "managed_domains_connection_zone_uq" ON "managed_domains" USING btree ("dns_connection_id","external_zone_id") WHERE "managed_domains"."external_zone_id" is not null;--> statement-breakpoint
CREATE INDEX "managed_domains_unready_state_idx" ON "managed_domains" USING btree ("state") WHERE "managed_domains"."state" <> 'ready';--> statement-breakpoint
CREATE INDEX "managed_domains_drift_detected_at_idx" ON "managed_domains" USING btree ("drift_detected_at") WHERE "managed_domains"."drift_detected_at" is not null;--> statement-breakpoint
CREATE INDEX "reconcile_runs_subject_started_at_idx" ON "reconcile_runs" USING btree ("subject_type","subject_id","started_at" DESC NULLS LAST);