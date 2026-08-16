CREATE TABLE "provisioning_template_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"step_kind" text NOT NULL,
	"provider" text,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"optional" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_template_steps_sequence_uq" UNIQUE("template_id","sequence"),
	CONSTRAINT "provisioning_template_steps_kind_check" CHECK ("provisioning_template_steps"."step_kind" in ('domain.declare', 'dns.point-at-target', 'dns.manual-record', 'proxy.ensure-resource', 'proxy.ensure-rules', 'mail.enable', 'mail.ensure-mailbox')),
	CONSTRAINT "provisioning_template_steps_provider_check" CHECK ("provisioning_template_steps"."provider" is null or "provisioning_template_steps"."provider" in ('cloudflare', 'purelymail', 'pangolin')),
	CONSTRAINT "provisioning_template_steps_sequence_check" CHECK ("provisioning_template_steps"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provisioning_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provisioning_templates_name_uq" UNIQUE("name"),
	CONSTRAINT "provisioning_templates_version_check" CHECK ("provisioning_templates"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "template_run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"step_kind" text NOT NULL,
	"provider" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"blocked_reason" text,
	"reconcile_run_id" uuid,
	"provider_operation_key" text,
	"error_code" text,
	"error_detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "template_run_steps_sequence_uq" UNIQUE("run_id","sequence"),
	CONSTRAINT "template_run_steps_kind_check" CHECK ("template_run_steps"."step_kind" in ('domain.declare', 'dns.point-at-target', 'dns.manual-record', 'proxy.ensure-resource', 'proxy.ensure-rules', 'mail.enable', 'mail.ensure-mailbox')),
	CONSTRAINT "template_run_steps_provider_check" CHECK ("template_run_steps"."provider" is null or "template_run_steps"."provider" in ('cloudflare', 'purelymail', 'pangolin')),
	CONSTRAINT "template_run_steps_status_check" CHECK ("template_run_steps"."status" in ('pending', 'running', 'succeeded', 'blocked', 'failed', 'skipped')),
	CONSTRAINT "template_run_steps_blocked_reason_check" CHECK (("template_run_steps"."status" = 'blocked') = ("template_run_steps"."blocked_reason" is not null)),
	CONSTRAINT "template_run_steps_sequence_check" CHECK ("template_run_steps"."sequence" >= 0)
);
--> statement-breakpoint
CREATE TABLE "template_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"template_version" integer NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compiled_plan" jsonb NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"actor_user_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "template_runs_status_check" CHECK ("template_runs"."status" in ('running', 'succeeded', 'partial', 'failed')),
	CONSTRAINT "template_runs_template_version_check" CHECK ("template_runs"."template_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "reconcile_runs" DROP CONSTRAINT "reconcile_runs_subject_type_check";--> statement-breakpoint
ALTER TABLE "provisioning_template_steps" ADD CONSTRAINT "provisioning_template_steps_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."provisioning_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_templates" ADD CONSTRAINT "provisioning_templates_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_run_steps" ADD CONSTRAINT "template_run_steps_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."template_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_run_steps" ADD CONSTRAINT "template_run_steps_reconcile_run_fk" FOREIGN KEY ("reconcile_run_id") REFERENCES "public"."reconcile_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_run_steps" ADD CONSTRAINT "template_run_steps_provider_operation_fk" FOREIGN KEY ("provider_operation_key") REFERENCES "public"."provider_operations"("idempotency_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_runs" ADD CONSTRAINT "template_runs_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."provisioning_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provisioning_template_steps_template_id_idx" ON "provisioning_template_steps" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provisioning_templates_default_uq" ON "provisioning_templates" USING btree ("is_default") WHERE "provisioning_templates"."is_default";--> statement-breakpoint
CREATE INDEX "template_run_steps_run_id_idx" ON "template_run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "template_runs_template_id_idx" ON "template_runs" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "template_runs_status_idx" ON "template_runs" USING btree ("status");--> statement-breakpoint
ALTER TABLE "reconcile_runs" ADD CONSTRAINT "reconcile_runs_subject_type_check" CHECK ("reconcile_runs"."subject_type" in ('domain', 'hosting_target', 'token', 'proxy_resource', 'template_run'));