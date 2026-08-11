/**
 * Provider ingestion provenance: durable source-event envelopes and
 * provider-native object snapshots.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { connections } from "./connections.ts";

export const sourceEvents = pgTable(
  "source_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => connections.id),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    externalEventId: text("external_event_id"),
    externalObjectType: text("external_object_type"),
    externalObjectId: text("external_object_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
    processingStatus: text("processing_status").notNull(),
    processingAttempts: integer("processing_attempts").notNull().default(0),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    index("source_events_connection_id_received_at_idx").on(
      table.connectionId,
      table.receivedAt.desc(),
    ),
    index("source_events_provider_event_type_received_at_idx").on(
      table.provider,
      table.eventType,
      table.receivedAt.desc(),
    ),
    index("source_events_external_object_idx").on(
      table.externalObjectType,
      table.externalObjectId,
    ),
    // Partial uniqueness where the provider supplies a stable event id.
    uniqueIndex("source_events_connection_provider_external_event_uq")
      .on(table.connectionId, table.provider, table.externalEventId)
      .where(sql`${table.externalEventId} is not null`),
  ],
);

export const providerObjects = pgTable(
  "provider_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id").references(() => connections.id),
    provider: text("provider").notNull(),
    objectType: text("object_type").notNull(),
    externalObjectId: text("external_object_id").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    providerUpdatedAt: timestamp("provider_updated_at", {
      withTimezone: true,
    }),
    payload: jsonb("payload").notNull(),
    payloadHash: text("payload_hash").notNull(),
  },
  (table) => [
    index("provider_objects_identity_fetched_at_idx").on(
      table.provider,
      table.objectType,
      table.externalObjectId,
      table.fetchedAt.desc(),
    ),
    index("provider_objects_payload_hash_idx").on(table.payloadHash),
  ],
);
