/**
 * Opportunity rules (Phase 2): declarative, operator-owned rules that score
 * derived `market_events` into notifiable opportunities.
 *
 * This table is the Phase 2 extension that finally uses the previously
 * dangling `market_events.rule_id` column. `rule_id` is deliberately NOT a
 * foreign key: it is a historical attribution stamp (same intent as
 * `audit_events.actor_user_id`), so deleting a rule can never block, rewrite,
 * or cascade into recorded event history.
 *
 * `conditions` holds a small DECLARATIVE grammar validated by Zod in
 * @loxep/market (`opportunityConditionsSchema`) — not a generic workflow/rule
 * engine, which the Phase 0 non-goals forbid. `score_weight` is the rule's
 * multiplier in the documented scoring formula.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.ts";
import { emptyJsonObject } from "./settings.ts";

export const opportunityRules = pgTable(
  "opportunity_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Smaller runs first (monitor_targets / Graphile Worker convention). */
    priority: integer("priority").notNull().default(0),
    conditions: jsonb("conditions").notNull().default(emptyJsonObject),
    /** Multiplier in the scoring formula; not money, but exact decimal. */
    scoreWeight: numeric("score_weight", { precision: 10, scale: 4 })
      .notNull()
      .default("1.0000"),
    // ADR-0020: nullable SET NULL FK to the Better Auth user id.
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The evaluation loop's only read: enabled rules in priority order.
    index("opportunity_rules_enabled_priority_idx")
      .on(table.enabled, table.priority)
      .where(sql`${table.enabled} = true`),
  ],
);
