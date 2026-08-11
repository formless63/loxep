/**
 * Append-oriented audit evidence of user/admin configuration changes.
 *
 * `actor_user_id` is an intentional NON-FK historical identity reference
 * (ADR-0020 form 2): the identifier itself is the historical fact and must
 * survive user deletion verbatim. Secrets are redacted before audit
 * serialization.
 */
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { emptyJsonObject } from "./settings.ts";

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  actorUserId: text("actor_user_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  requestId: text("request_id"),
  metadata: jsonb("metadata").notNull().default(emptyJsonObject),
});
