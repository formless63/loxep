/**
 * Migration runner integration tests (ADR-0018) against a real
 * PostgreSQL + TimescaleDB (docker/compose.dev.yml).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkMigrationState, runMigrations } from "../src/migrate.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

/**
 * 0000 foundation, 0001 observations hypertable, 0002 opportunity rules,
 * 0003 commerce orders and catalog, 0004 link-table constraints,
 * 0005 inventory, acquisition, and shipments,
 * 0006 expenses and counterparties, 0007 order-payload retention,
 * 0008 user display name, 0009 accounting books, chart, and journal,
 * 0010 posting rules and journal source links,
 * 0011 projects, time entries, billing rates, material uses, and sites,
 * 0012 infrastructure control plane (Phase 7 milestone 1): hosting targets,
 *      managed domains, DNS records, reconcile runs and steps, drift
 *      findings, and the provider-operation idempotency ledger.
 * 0013 infrastructure mail (Phase 7 milestone 2): mailbox templates/entries,
 *      mail domains, mailboxes, and managed_domains' mailbox_template_id FK.
 * 0014 integration_health (Phase 8 milestone 1, loxep-ovj.1): the one shared-
 *      foundation health-rollup table, no alterations to any other table.
 * 0015 inventory enrichment (Flipping lifecycle M3, loxep-dgf.3):
 *      inventory_items gains six nullable/defaulted columns (description,
 *      sale_mode, package weight/dimensions) and inventory_item_specifics
 *      is new. No DDL for images — media_links (0004) already covers them.
 * 0016 infrastructure tokens (Phase 7 milestone 3, loxep-lmy.3): the
 *      design's last two tables — dns_provider_tokens (a narrow per-host
 *      DNS-edit credential Loxep MINTS) and dns_provider_token_zones (the
 *      zone-scope INTENT a policy sync rebuilds from). No existing table
 *      gains a column.
 * 0017 documents (Phase 9 milestone 4, loxep-dgf.4): the Documents domain's
 *      first two tables — documents and document_line_candidates. A parse
 *      is never a fact: candidates carry a disposition and an unenforced
 *      target_kind/target_id STAMP, never a foreign key into expenses,
 *      acquisitions, or inventory_items. No existing table gains a column.
 * 0018 purchase idempotency (Flipping lifecycle design 2a, loxep-k5p): one
 *      partial unique index, acquisitions_connection_external_ref_uq on
 *      acquisitions (connection_id, external_reference) where both are not
 *      null. Closes the eBay-purchase-ingestion concurrent-sync race
 *      loxep-dgf.5 flagged; no column added, no other table touched.
 * 0019 manual and draft listings (Flipping lifecycle M6, loxep-dgf.6):
 *      channel_listings gains listing_code (backfilled, then unique) and
 *      relaxes connection_id/external_listing_id to nullable behind a
 *      partial unique index (NULLS NOT DISTINCT WHERE external_listing_id
 *      is not null) and channel_listings_manual_connection_check.
 *      orders.connection_id is relaxed the same way (design open question 7,
 *      PROVISIONAL), with orders_manual_connection_check and the existing
 *      unique widened to NULLS NOT DISTINCT (no partial WHERE needed there).
 * 0020 integration_health status transitions (weave audit 2026-08 finding 5,
 *      health half, loxep-oii): integration_health gains nullable
 *      previous_status/status_changed_at, written only when upsertHealth
 *      sees the incoming status differ from the stored one. Not a health-
 *      history table — one prior value per subject, same one-row-per-
 *      subject shape as the rest of the table. Three CHECKs extend the
 *      table's existing biconditional discipline to the new pair.
 */
const MIGRATION_FILE_COUNT = 21;

describe("runMigrations / checkMigrationState", () => {
  const dbName = scratchDbName("loxep_test_migrate");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("reports all migrations pending on a fresh database", async () => {
    const state = await checkMigrationState(databaseUrl);
    expect(state.upToDate).toBe(false);
    expect(state.pending).toBe(MIGRATION_FILE_COUNT);
  });

  it("migrates from zero", async () => {
    const result = await runMigrations({ databaseUrl, logger: silentLogger });
    expect(result.applied).toBe(MIGRATION_FILE_COUNT);
  });

  it("reports up to date after migrating", async () => {
    const state = await checkMigrationState(databaseUrl);
    expect(state.upToDate).toBe(true);
    expect(state.pending).toBe(0);
  });

  it("is a no-op on the second run", async () => {
    const result = await runMigrations({ databaseUrl, logger: silentLogger });
    expect(result.applied).toBe(0);
  });
});

describe("concurrent migration invocations", () => {
  const dbName = scratchDbName("loxep_test_concurrent");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("advisory lock serializes two concurrent runs on a fresh database", async () => {
    const [first, second] = await Promise.all([
      runMigrations({ databaseUrl, logger: silentLogger }),
      runMigrations({ databaseUrl, logger: silentLogger }),
    ]);
    // Exactly one invocation applies everything; the other waits on the
    // advisory lock and then finds nothing left to do.
    expect(first.applied + second.applied).toBe(MIGRATION_FILE_COUNT);
    expect([first.applied, second.applied]).toContain(0);

    const state = await checkMigrationState(databaseUrl);
    expect(state.upToDate).toBe(true);
  });
});
