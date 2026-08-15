-- Pangolin chain design milestone 2 (loxep-acj.2). Physical realization of
-- `apps/docs/src/content/docs/architecture/pangolin-chain-design.md`'s "The
-- proxy provider port" section and its resolution of open question 7 ("Do
-- proxy resources and their rules deserve their own intent tables?" — yes,
-- because a rule set is a multi-row set with per-row ownership, exactly the
-- shape `dns_records.owner` already exists to express).
--
-- `proxy_resources` is the chain's third link (domain -> Cloudflare record ->
-- Pangolin resource -> hosting target); `proxy_resource_rules` is its
-- sibling rule-set intent table, `owner`-tagged the same way `dns_records`
-- is so the reconciler never rewrites a `manual` row. Both self-retire their
-- provider id the same way `container-host-port.ts`'s `externalHostId`
-- bootstrap does — no provider id is required at declare time, and nothing
-- here is ever applied to Pangolin: this milestone's reconciler is
-- CHECK-MODE ONLY.
--
-- `reconcile_runs.subject_type`'s CHECK widens to include `proxy_resource` —
-- milestone 1 (loxep-lmy.1) reserved this by name in its own doc comment.
--
-- No `economic_entity_id` on either table (ADR-0017) — a reverse-proxy
-- resource is not attributable activity.
CREATE TABLE "proxy_resource_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proxy_resource_id" uuid NOT NULL,
	"action" text NOT NULL,
	"match" text NOT NULL,
	"value" text NOT NULL,
	"priority" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner" text DEFAULT 'manual' NOT NULL,
	"external_rule_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_resource_rules_natural_key_uq" UNIQUE("proxy_resource_id","action","match","value"),
	CONSTRAINT "proxy_resource_rules_action_check" CHECK ("proxy_resource_rules"."action" in ('ACCEPT', 'DROP', 'PASS')),
	CONSTRAINT "proxy_resource_rules_match_check" CHECK ("proxy_resource_rules"."match" in ('CIDR', 'IP', 'PATH', 'COUNTRY', 'COUNTRY_IS_NOT', 'ASN', 'REGION')),
	CONSTRAINT "proxy_resource_rules_owner_check" CHECK ("proxy_resource_rules"."owner" in ('template', 'manual', 'dynamic_ip')),
	CONSTRAINT "proxy_resource_rules_priority_check" CHECK ("proxy_resource_rules"."priority" >= 0)
);
--> statement-breakpoint
CREATE TABLE "proxy_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"hosting_target_id" uuid NOT NULL,
	"subdomain" text,
	"mode" text DEFAULT 'http' NOT NULL,
	"proxy_port" integer,
	"ssl" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"external_resource_id" text,
	"external_domain_id" text,
	"last_applied_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_resources_domain_id_subdomain_uq" UNIQUE NULLS NOT DISTINCT("domain_id","subdomain"),
	CONSTRAINT "proxy_resources_mode_check" CHECK ("proxy_resources"."mode" in ('http', 'ssh', 'rdp', 'vnc', 'tcp', 'udp'))
);
--> statement-breakpoint
ALTER TABLE "reconcile_runs" DROP CONSTRAINT "reconcile_runs_subject_type_check";--> statement-breakpoint
ALTER TABLE "proxy_resource_rules" ADD CONSTRAINT "proxy_resource_rules_proxy_resource_fk" FOREIGN KEY ("proxy_resource_id") REFERENCES "public"."proxy_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_resources" ADD CONSTRAINT "proxy_resources_domain_id_managed_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_resources" ADD CONSTRAINT "proxy_resources_hosting_target_id_hosting_targets_id_fk" FOREIGN KEY ("hosting_target_id") REFERENCES "public"."hosting_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_resources" ADD CONSTRAINT "proxy_resources_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proxy_resource_rules_proxy_resource_id_idx" ON "proxy_resource_rules" USING btree ("proxy_resource_id");--> statement-breakpoint
CREATE INDEX "proxy_resources_hosting_target_id_idx" ON "proxy_resources" USING btree ("hosting_target_id");--> statement-breakpoint
CREATE INDEX "proxy_resources_domain_id_idx" ON "proxy_resources" USING btree ("domain_id");--> statement-breakpoint
ALTER TABLE "reconcile_runs" ADD CONSTRAINT "reconcile_runs_subject_type_check" CHECK ("reconcile_runs"."subject_type" in ('domain', 'hosting_target', 'token', 'proxy_resource'));