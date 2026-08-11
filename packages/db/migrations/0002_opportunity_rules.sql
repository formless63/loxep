-- opportunity_rules: Phase 2 declarative opportunity rules and scoring
-- (foundation-schema.md "Opportunity rules"; roadmap Phase 2). This is the
-- extension that finally uses the previously dangling market_events.rule_id
-- column; rule_id stays a non-FK historical attribution stamp, so deleting a
-- rule never blocks, cascades into, or rewrites recorded event history.
CREATE TABLE "opportunity_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score_weight" numeric(10, 4) DEFAULT '1.0000' NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "opportunity_rules" ADD CONSTRAINT "opportunity_rules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "opportunity_rules_enabled_priority_idx" ON "opportunity_rules" USING btree ("enabled","priority") WHERE "opportunity_rules"."enabled" = true;