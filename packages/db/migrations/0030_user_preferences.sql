-- loxep-lbj: durable per-user preferences, replacing loxep-koj's
-- localStorage-only pinned-pages persistence.
--
-- `user_preferences` is the per-user sibling of `application_settings`: one
-- small, generic (user_id, key) -> value table rather than a bespoke table
-- per preference. `key` is a registered preference key validated against a
-- Zod schema at the @loxep/domain service boundary; this migration carries
-- no validation, matching every other table in this schema.
--
-- `user_id` is a NOT NULL, ON DELETE CASCADE reference to the Better Auth
-- user, not ADR-0020's usual nullable SET NULL provenance form: it is part
-- of the primary key (the row's owner, not a "who touched this" column), so
-- it cannot be nullable. A preference has no meaning independent of the user
-- it belongs to, the same reasoning Better Auth's own session/account rows
-- use for their own CASCADE. See packages/db/src/schema/preferences.ts's doc
-- comment for the full PROVISIONAL judgment call.
CREATE TABLE "user_preferences" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_key_pk" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;