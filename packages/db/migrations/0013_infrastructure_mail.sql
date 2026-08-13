-- Phase 7 Infrastructure control plane, milestone 2 — mail (loxep-lmy.2).
--
-- From apps/docs/src/content/docs/architecture/infrastructure-control-design.md:
-- the FOUR tables its "Migration plan sketch" ordering assigns to milestone 2
-- (steps 3 and 9), plus the one constraint milestone 1 deferred by name:
--
--   mailbox_templates          the data-driven standard address set
--   mailbox_template_entries   one address in a template
--   mail_domains               provider registration + ownership verification
--   mailboxes                  the intended mailboxes and aliases (INTENT)
--
--   managed_domains.mailbox_template_id gains its FOREIGN KEY. Migration 0012's
--   header states the promise being kept here: that column "ships WITHOUT its
--   FK and milestone 2 adds the constraint ... ADD CONSTRAINT against an empty
--   relationship is free; ADD COLUMN later would not be."
--
-- ## What this migration deliberately does NOT create
--
--   dns_provider_tokens / dns_provider_token_zones  milestone 3 (ordering 8)
--
-- No existing table gains a COLUMN — still the design's rule, still held. The
-- one ALTER below adds a constraint to a column that already exists. There is
-- no economic_entity_id anywhere (ADR-0017), no money column, and no hypertable:
-- a mailbox is a statement of intent, not a temporal sample.
--
-- ## Verified against the PROVIDER, not carried forward from the design
--
-- The design deliberately lists NO mail record set and instructs that it be
-- verified "against the mail provider's own current documentation at
-- implementation time ... the difference between working mail and a failure
-- mode that presents weeks late." Verified against purelymail.com/docs/domainDocs
-- and the Purelymail OpenAPI document (news.purelymail.com/api/swagger-spec.js,
-- info.version 0.0.1) on 2026-08-13. The set lives in
-- packages/integrations/purelymail/src/records.ts, NOT in this schema — seven
-- records, every one of them unproxied, materialized into dns_records with
-- owner = 'mail'.
--
-- Two facts from that verification shape tables here:
--
--   1. The ownership code is per-ACCOUNT, not per-domain: getOwnershipCode takes
--      an EMPTY request body. mail_domains.ownership_code is still per row
--      because it is evidence of what was published for THIS domain, and a
--      Loxep installation may hold more than one Purelymail connection.
--   2. Purelymail's own Cloudflare instructions say to set the DKIM CNAMEs to
--      "DNS only (this is very important)" — the provider stating the
--      never-proxy invariant that dns_records_mail_not_proxied_check already
--      enforces. Both belts remain load-bearing; this is the provider agreeing
--      with the constraint, not a reason to relax it.
--
-- ## ownership_code is NOT a secret
--
-- It is published in a public TXT record. It is stored in plaintext `text`, it
-- is safe in a redacted run-step summary, and it must not move into
-- application_secrets. The design says so explicitly "so the argument is not
-- had twice", and it is repeated here for the same reason.
--
-- ## mailboxes.secret_id ships, and what that does and does not decide
--
-- The generated mailbox password is written to application_secrets under
-- `infrastructure.mailbox.<mailboxes.id>` with the new `mailbox_password`
-- bundle purpose. In this milestone it is WRITE-ONLY: minted, sent to the
-- provider once, stored, and never read back by any surface.
--
-- The design's open question 1 — may a human ever read a stored secret back —
-- is OWNER-REVIEW-CRITICAL, unresolved, and needs an ADR. This column ships
-- under the answer that keeps BOTH resolutions available: shipping without it
-- would make "reveal" a migration, and shipping a reveal path would pre-empt
-- the ADR. No reveal server function, route, or UI exists in this milestone.
--
-- ## Verified at implementation time, per the design's "Before implementing"
--
--   * drizzle-kit 0.31.10 emits the partial unique index over a bare boolean
--     (mailbox_templates_default_uq, the design's `unique(is_default) where
--     is_default`) and both biconditional multi-column CHECKs correctly.
--     Nothing had to be hand-written and no constraint was weakened.
--   * FK names measured against PostgreSQL's 63-byte limit. The design names
--     mailbox_template_entries as a candidate and it is the closest:
--     `mailbox_template_entries_template_id_mailbox_templates_id_fk` is 60
--     bytes, inside the limit but with silent truncation as the failure mode,
--     so it is named explicitly (mailbox_template_entries_template_fk) exactly
--     as the design asked. managed_domains_mailbox_template_id_..._fk measures
--     59 and is left generated.
--   * mailboxes' unique(domain_id, local_part) covers tombstones, matching
--     dns_records' natural key: a re-declared address is RESURRECTED (its
--     desired_deleted_at cleared), never inserted twice. Open question 7's
--     resolution applied to the table that shares its shape.
--
CREATE TABLE "mail_domains" (
	"domain_id" uuid PRIMARY KEY NOT NULL,
	"mail_connection_id" uuid NOT NULL,
	"provider_added_at" timestamp with time zone,
	"ownership_code" text,
	"ownership_verified_at" timestamp with time zone,
	"verify_attempts" integer DEFAULT 0 NOT NULL,
	"last_verify_error" text,
	"last_verify_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_domains_verify_attempts_check" CHECK ("mail_domains"."verify_attempts" >= 0),
	CONSTRAINT "mail_domains_verified_implies_added_check" CHECK ("mail_domains"."ownership_verified_at" is null or "mail_domains"."provider_added_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "mailbox_template_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"kind" text NOT NULL,
	"forward_to" text,
	"generate_password" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_template_entries_local_part_uq" UNIQUE("template_id","local_part"),
	CONSTRAINT "mailbox_template_entries_kind_check" CHECK ("mailbox_template_entries"."kind" in ('mailbox', 'alias', 'catchall')),
	CONSTRAINT "mailbox_template_entries_forward_to_check" CHECK (("mailbox_template_entries"."kind" in ('alias', 'catchall')) = ("mailbox_template_entries"."forward_to" is not null))
);
--> statement-breakpoint
CREATE TABLE "mailbox_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailbox_templates_name_uq" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"local_part" text NOT NULL,
	"kind" text NOT NULL,
	"forward_to" text,
	"secret_id" uuid,
	"provider_created_at" timestamp with time zone,
	"desired_deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mailboxes_domain_local_part_uq" UNIQUE("domain_id","local_part"),
	CONSTRAINT "mailboxes_kind_check" CHECK ("mailboxes"."kind" in ('mailbox', 'alias', 'catchall')),
	CONSTRAINT "mailboxes_forward_to_check" CHECK (("mailboxes"."kind" in ('alias', 'catchall')) = ("mailboxes"."forward_to" is not null))
);
--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_domain_id_managed_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_mail_connection_id_connections_id_fk" FOREIGN KEY ("mail_connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_template_entries" ADD CONSTRAINT "mailbox_template_entries_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."mailbox_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_domain_id_managed_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."managed_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_secret_id_application_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."application_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_domains_unverified_idx" ON "mail_domains" USING btree ("domain_id") WHERE "mail_domains"."ownership_verified_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_templates_default_uq" ON "mailbox_templates" USING btree ("is_default") WHERE "mailbox_templates"."is_default";--> statement-breakpoint
CREATE INDEX "mailboxes_domain_id_live_idx" ON "mailboxes" USING btree ("domain_id") WHERE "mailboxes"."desired_deleted_at" is null;--> statement-breakpoint
ALTER TABLE "managed_domains" ADD CONSTRAINT "managed_domains_mailbox_template_id_mailbox_templates_id_fk" FOREIGN KEY ("mailbox_template_id") REFERENCES "public"."mailbox_templates"("id") ON DELETE no action ON UPDATE no action;