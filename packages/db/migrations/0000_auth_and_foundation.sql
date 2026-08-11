-- TimescaleDB must be enabled from the first migration (ADR-0002).
-- The timescale/timescaledb image pre-installs the extension in template1;
-- IF NOT EXISTS keeps this a no-op there while enabling it on plain
-- PostgreSQL servers that have the extension available.
CREATE EXTENSION IF NOT EXISTS timescaledb;--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"parent_entity_id" uuid,
	"legal_name" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_secret_versions" (
	"secret_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"key_version" integer NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_secret_versions_secret_id_version_pk" PRIMARY KEY("secret_id","version")
);
--> statement-breakpoint
CREATE TABLE "application_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"secret_key" text NOT NULL,
	"purpose" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_secrets_secret_key_unique" UNIQUE("secret_key")
);
--> statement-breakpoint
CREATE TABLE "application_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"updated_by_user_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection_credential_versions" (
	"credential_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"key_version" integer NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"expires_at" timestamp with time zone,
	"refresh_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_credential_versions_credential_id_version_pk" PRIMARY KEY("credential_id","version")
);
--> statement-breakpoint
CREATE TABLE "connection_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"credential_type" text NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_credentials_connection_id_credential_type_uq" UNIQUE("connection_id","credential_type")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"economic_entity_id" uuid,
	"external_account_id" text,
	"external_account_name" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error_code" text
);
--> statement-breakpoint
CREATE TABLE "provider_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"object_type" text NOT NULL,
	"external_object_id" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"provider" text NOT NULL,
	"event_type" text NOT NULL,
	"external_event_id" text,
	"external_object_type" text,
	"external_object_id" text,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"processing_status" text NOT NULL,
	"processing_attempts" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "marketplace_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"marketplace" text NOT NULL,
	"external_item_id" text NOT NULL,
	"seller_external_id" text,
	"canonical_url" text,
	"title" text,
	"condition_code" text,
	"category_external_id" text,
	"listing_type" text,
	"listing_started_at" timestamp with time zone,
	"listing_ends_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"current_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_items_provider_marketplace_external_item_uq" UNIQUE("provider","marketplace","external_item_id")
);
--> statement-breakpoint
CREATE TABLE "monitor_items" (
	"monitor_target_id" uuid NOT NULL,
	"marketplace_item_id" uuid NOT NULL,
	"first_discovered_at" timestamp with time zone NOT NULL,
	"last_matched_at" timestamp with time zone NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "monitor_items_monitor_target_id_marketplace_item_id_pk" PRIMARY KEY("monitor_target_id","marketplace_item_id")
);
--> statement-breakpoint
CREATE TABLE "monitor_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid,
	"target_type" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_seconds" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"last_poll_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"backoff_until" timestamp with time zone,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"marketplace_item_id" uuid NOT NULL,
	"monitor_target_id" uuid,
	"event_type" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"from_observed_at" timestamp with time zone,
	"to_observed_at" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rule_id" uuid,
	"deduplication_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_events_deduplication_key_unique" UNIQUE("deduplication_key")
);
--> statement-breakpoint
CREATE TABLE "media_links" (
	"media_object_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"purpose" text NOT NULL,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_backend_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text,
	"mime_type" text,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "media_objects_storage_backend_id_storage_key_uq" UNIQUE("storage_backend_id","storage_key")
);
--> statement-breakpoint
CREATE TABLE "storage_backends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_migration_objects" (
	"migration_id" uuid NOT NULL,
	"media_object_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"verified_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "storage_migration_objects_migration_id_media_object_id_pk" PRIMARY KEY("migration_id","media_object_id")
);
--> statement-breakpoint
CREATE TABLE "storage_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_backend_id" uuid NOT NULL,
	"destination_backend_id" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"connection_id" uuid,
	"external_type" text NOT NULL,
	"external_id" text,
	"url" text NOT NULL,
	"title" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_links" (
	"external_resource_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"purpose" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_event_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"provider_message_id" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_market_event_id_endpoint_id_uq" UNIQUE("market_event_id","endpoint_id")
);
--> statement-breakpoint
CREATE TABLE "notification_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"market_event_type" text,
	"monitor_target_id" uuid,
	"endpoint_id" uuid NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"before" jsonb,
	"after" jsonb,
	"request_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_entities" ADD CONSTRAINT "economic_entities_parent_entity_id_economic_entities_id_fk" FOREIGN KEY ("parent_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_secret_versions" ADD CONSTRAINT "application_secret_versions_secret_id_application_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."application_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_secrets" ADD CONSTRAINT "application_secrets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_settings" ADD CONSTRAINT "application_settings_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_credential_versions" ADD CONSTRAINT "connection_credential_versions_credential_id_connection_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."connection_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_credentials" ADD CONSTRAINT "connection_credentials_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_economic_entity_id_economic_entities_id_fk" FOREIGN KEY ("economic_entity_id") REFERENCES "public"."economic_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_objects" ADD CONSTRAINT "provider_objects_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_items" ADD CONSTRAINT "monitor_items_monitor_target_id_monitor_targets_id_fk" FOREIGN KEY ("monitor_target_id") REFERENCES "public"."monitor_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_items" ADD CONSTRAINT "monitor_items_marketplace_item_id_marketplace_items_id_fk" FOREIGN KEY ("marketplace_item_id") REFERENCES "public"."marketplace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_targets" ADD CONSTRAINT "monitor_targets_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_targets" ADD CONSTRAINT "monitor_targets_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_marketplace_item_id_marketplace_items_id_fk" FOREIGN KEY ("marketplace_item_id") REFERENCES "public"."marketplace_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_events" ADD CONSTRAINT "market_events_monitor_target_id_monitor_targets_id_fk" FOREIGN KEY ("monitor_target_id") REFERENCES "public"."monitor_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_links" ADD CONSTRAINT "media_links_media_object_id_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_storage_backend_id_storage_backends_id_fk" FOREIGN KEY ("storage_backend_id") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_backends" ADD CONSTRAINT "storage_backends_secret_id_application_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."application_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_backends" ADD CONSTRAINT "storage_backends_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migration_objects" ADD CONSTRAINT "storage_migration_objects_migration_id_storage_migrations_id_fk" FOREIGN KEY ("migration_id") REFERENCES "public"."storage_migrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migration_objects" ADD CONSTRAINT "storage_migration_objects_media_object_id_media_objects_id_fk" FOREIGN KEY ("media_object_id") REFERENCES "public"."media_objects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_source_backend_id_storage_backends_id_fk" FOREIGN KEY ("source_backend_id") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_destination_backend_id_storage_backends_id_fk" FOREIGN KEY ("destination_backend_id") REFERENCES "public"."storage_backends"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_migrations" ADD CONSTRAINT "storage_migrations_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_resources" ADD CONSTRAINT "external_resources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_external_resource_id_external_resources_id_fk" FOREIGN KEY ("external_resource_id") REFERENCES "public"."external_resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_market_event_id_market_events_id_fk" FOREIGN KEY ("market_event_id") REFERENCES "public"."market_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_endpoint_id_notification_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."notification_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD CONSTRAINT "notification_endpoints_secret_id_application_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."application_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_endpoints" ADD CONSTRAINT "notification_endpoints_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_monitor_target_id_monitor_targets_id_fk" FOREIGN KEY ("monitor_target_id") REFERENCES "public"."monitor_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_endpoint_id_notification_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."notification_endpoints"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "connections_provider_status_idx" ON "connections" USING btree ("provider","status");--> statement-breakpoint
CREATE INDEX "connections_economic_entity_id_idx" ON "connections" USING btree ("economic_entity_id");--> statement-breakpoint
CREATE INDEX "connections_created_by_user_id_idx" ON "connections" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "provider_objects_identity_fetched_at_idx" ON "provider_objects" USING btree ("provider","object_type","external_object_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "provider_objects_payload_hash_idx" ON "provider_objects" USING btree ("payload_hash");--> statement-breakpoint
CREATE INDEX "source_events_connection_id_received_at_idx" ON "source_events" USING btree ("connection_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "source_events_provider_event_type_received_at_idx" ON "source_events" USING btree ("provider","event_type","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "source_events_external_object_idx" ON "source_events" USING btree ("external_object_type","external_object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_connection_provider_external_event_uq" ON "source_events" USING btree ("connection_id","provider","external_event_id") WHERE "source_events"."external_event_id" is not null;--> statement-breakpoint
CREATE INDEX "marketplace_items_provider_marketplace_seller_idx" ON "marketplace_items" USING btree ("provider","marketplace","seller_external_id");--> statement-breakpoint
CREATE INDEX "marketplace_items_last_seen_at_idx" ON "marketplace_items" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitor_targets_enabled_next_poll_at_idx" ON "monitor_targets" USING btree ("enabled","next_poll_at") WHERE "monitor_targets"."enabled" = true;--> statement-breakpoint
CREATE INDEX "monitor_targets_connection_id_target_type_idx" ON "monitor_targets" USING btree ("connection_id","target_type");--> statement-breakpoint
CREATE INDEX "media_objects_sha256_idx" ON "media_objects" USING btree ("sha256");