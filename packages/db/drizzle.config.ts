import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration (ADR-0006).
 *
 * Schema files are listed explicitly instead of globbing the schema directory
 * because `src/schema/observations.ts` (marketplace_item_observations) must
 * NOT be included: that table is created by a hand-written SQL migration as a
 * TimescaleDB hypertable (see migrations/0002_observations_hypertable.sql)
 * and exists in Drizzle only for typing/query building.
 *
 * Migrations are reviewed artifacts; never rely on push/auto-sync behavior.
 */
export default defineConfig({
  dialect: "postgresql",
  out: "./migrations",
  schema: [
    "./src/schema/auth.ts",
    "./src/schema/entities.ts",
    "./src/schema/settings.ts",
    "./src/schema/connections.ts",
    "./src/schema/provenance.ts",
    "./src/schema/monitoring.ts",
    "./src/schema/events.ts",
    "./src/schema/opportunities.ts",
    "./src/schema/storage.ts",
    "./src/schema/resources.ts",
    "./src/schema/notifications.ts",
    "./src/schema/audit.ts",
    "./src/schema/commerce.ts",
    "./src/schema/inventory.ts",
  ],
});
