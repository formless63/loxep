/**
 * Economic entities (ADR-0017).
 *
 * Minimal attribution/business-context records: not users, not permission
 * containers, not accounting books. `kind` is application-owned text with
 * TypeScript validation, never a PostgreSQL enum.
 */
import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const economicEntities = pgTable("economic_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  parentEntityId: uuid("parent_entity_id").references(
    (): AnyPgColumn => economicEntities.id,
  ),
  legalName: text("legal_name"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Application-owned `kind` values; descriptive, not a tax/legal determination. */
export const ECONOMIC_ENTITY_KINDS = [
  "individual",
  "sole_proprietorship",
  "llc",
  "partnership",
  "corporation",
  "assumed_name",
  "operating_unit",
  "other",
] as const;

export type EconomicEntityKind = (typeof ECONOMIC_ENTITY_KINDS)[number];
