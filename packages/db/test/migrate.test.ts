/**
 * Migration runner integration tests (ADR-0018) against a real
 * PostgreSQL + TimescaleDB (docker/compose.dev.yml).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkMigrationState,
  closeDb,
  createDb,
  REQUIRED_TIMESCALEDB_VERSION,
  runMigrations,
} from "../src/migrate.ts";
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
 * 0021 external_resources idempotency (loxep-uhs, blocking finding from the
 *      Beszel weave design loxep-y64): one partial unique index,
 *      external_resources_provider_type_external_id_uq on external_resources
 *      (provider, external_type, external_id) where external_id is not
 *      null. Closes the scheduled-discovery duplicate-row race so
 *      @loxep/domain's new upsertExternalResource has an ON CONFLICT
 *      target; tier-1 links with a null external_id are unaffected. No
 *      column added, no other table touched.
 * 0022 notification_events (weave audit 2026-08 finding 5, notification
 *      half, loxep-oii; ADR-0023): the detection-side ledger of notifiable
 *      facts, decoupling notification_deliveries from market_events so any
 *      event class can be notified. notification_deliveries.market_event_id
 *      relaxes to nullable behind a new event_id.
 * 0023 counterparty contact names (Trading partners M1, loxep-cd3.1):
 *      counterparty_contacts gains nullable given_name/family_name — the one
 *      genuine schema gap the Invoice Ninja client-contact parity mapping
 *      found. No backfill, no constraint; display_name stays authoritative.
 * 0024 expense payee counterparty (Trading partners M1, loxep-cd3.1):
 *      expenses gains nullable payee_counterparty_id (FK to counterparties,
 *      explicitly named expenses_payee_counterparty_fk) plus a partial
 *      index. No backfill; payee_name stays written on every expense.
 * 0029 host addresses (loxep-bub): host_addresses replaces
 *      hosting_targets.address_v4/address_v6 with a typed, multi-row model
 *      (kind wan/lan/tailnet/other, family v4/v6, provenance
 *      operator_declared/observed:<provider>, primary-per-kind-and-family).
 *      Every existing address_v4/address_v6 value backfills into a wan,
 *      operator_declared, primary row before both columns are dropped —
 *      pre-release, a clean cut. hosting_targets_addressable_check is
 *      dropped (a CHECK cannot query another table) and re-expressed as a
 *      service-level invariant in @loxep/infrastructure.
 * 0032 storage backend default invariants: repairs any legacy disabled or
 *      duplicate defaults, then enforces at most one default and requires
 *      that a selected default is enabled.
 * 0033 Better Auth 1.7 account identity: adds the required issuer, preserves
 *      Loxep 1.6's provider-scoped OIDC/credential identities, then enforces
 *      uniqueness across (issuer, account_id).
 * 0034 TimescaleDB 2.29.2 extension marker: verifies the explicit migration
 *      runner upgraded an existing database's installed extension after the
 *      pinned HA/all image changed.
 */
const MIGRATION_FILE_COUNT = 35;

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

describe("0034 TimescaleDB extension upgrade", () => {
  const dbName = scratchDbName("loxep_test_timescaledb_upgrade");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("upgrades an existing 2.29.1 database before applying schema migrations", async () => {
    const legacy = createDb(databaseUrl);
    try {
      // The pinned HA/all image intentionally carries prior extension files so
      // an existing volume can be upgraded in place. This is the first SQL on
      // the pool's new connection, matching Timescale's loader requirement.
      await legacy.pool.query(
        `create extension timescaledb version '2.29.1'`,
      );
      const before = await legacy.pool.query<{ extversion: string }>(
        `select extversion
           from pg_catalog.pg_extension
          where extname = 'timescaledb'`,
      );
      expect(before.rows[0]?.extversion).toBe("2.29.1");
    } finally {
      await closeDb(legacy);
    }

    const [first, second] = await Promise.all([
      runMigrations({ databaseUrl, logger: silentLogger }),
      runMigrations({ databaseUrl, logger: silentLogger }),
    ]);
    expect(first.applied + second.applied).toBe(MIGRATION_FILE_COUNT);
    expect([first.applied, second.applied]).toContain(0);

    const verify = createDb(databaseUrl);
    try {
      const result = await verify.pool.query<{ extversion: string }>(
        `select extversion
           from pg_catalog.pg_extension
          where extname = 'timescaledb'`,
      );
      expect(result.rows[0]?.extversion).toBe(
        REQUIRED_TIMESCALEDB_VERSION,
      );
    } finally {
      await closeDb(verify);
    }
  });
});

describe("0032 storage-backend default invariant upgrade", () => {
  const dbName = scratchDbName("loxep_test_storage_default_upgrade");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("repairs legacy disabled and duplicate defaults before enforcing constraints", async () => {
    await runMigrations({ databaseUrl, logger: silentLogger });

    // Reconstruct a database at 0031: remove 0032 and every later schema
    // object plus their migration ledger rows, then seed states the old
    // service could produce.
    const setup = createDb(databaseUrl);
    try {
      await setup.pool.query(`drop index "account_issuer_accountId_uidx"`);
      await setup.pool.query(`alter table "account" drop column "issuer"`);
      await setup.pool.query(
        `alter table storage_backends
           drop constraint storage_backends_default_enabled_check`,
      );
      await setup.pool.query(`drop index storage_backends_default_uq`);
      await setup.pool.query(
        `insert into storage_backends (name, driver, enabled, is_default)
         values
           ('legacy enabled one', 'local', true, true),
           ('legacy enabled two', 'local', true, true),
           ('legacy disabled', 'local', false, true)`,
      );
      await setup.pool.query(
        `delete from drizzle.__drizzle_migrations
          where created_at in (
            select created_at from drizzle.__drizzle_migrations
            order by created_at desc
            limit 3
          )`,
      );
    } finally {
      await closeDb(setup);
    }

    await expect(
      runMigrations({ databaseUrl, logger: silentLogger }),
    ).resolves.toEqual({ applied: 3 });

    const verify = createDb(databaseUrl);
    try {
      const defaults = await verify.pool.query<{
        enabled: boolean;
        name: string;
      }>(
        `select name, enabled from storage_backends where is_default
         order by name`,
      );
      expect(defaults.rows).toHaveLength(1);
      expect(defaults.rows[0]?.enabled).toBe(true);
      expect(defaults.rows[0]?.name).toMatch(/^legacy enabled/);

      const disabled = await verify.pool.query<{ is_default: boolean }>(
        `select is_default from storage_backends
          where name = 'legacy disabled'`,
      );
      expect(disabled.rows[0]?.is_default).toBe(false);
    } finally {
      await closeDb(verify);
    }
  });
});

describe("0033 Better Auth account-issuer upgrade", () => {
  const dbName = scratchDbName("loxep_test_auth_issuer_upgrade");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("preserves supported 1.6 provider identities before enforcing the 1.7 key", async () => {
    await runMigrations({ databaseUrl, logger: silentLogger });

    // Reconstruct a database at 0032, including both identity namespaces the
    // shipped Loxep configuration can create. Password login is disabled, but
    // credential is a Better Auth local namespace and is handled defensively.
    const setup = createDb(databaseUrl);
    try {
      await setup.pool.query(`drop index "account_issuer_accountId_uidx"`);
      await setup.pool.query(`alter table "account" drop column "issuer"`);
      await setup.pool.query(
        `insert into "user" (id, name, email, updated_at)
         values
           ('issuer-oidc-user', 'OIDC User', 'issuer-oidc@example.test', now()),
           ('issuer-credential-user', 'Credential User', 'issuer-credential@example.test', now())`,
      );
      await setup.pool.query(
        `insert into "account"
           (id, account_id, provider_id, user_id, updated_at)
         values
           ('issuer-oidc-account', 'subject-123', 'oidc', 'issuer-oidc-user', now()),
           ('issuer-credential-account', 'issuer-credential-user', 'credential', 'issuer-credential-user', now())`,
      );
      await setup.pool.query(
        `delete from drizzle.__drizzle_migrations
          where created_at in (
            select created_at from drizzle.__drizzle_migrations
            order by created_at desc
            limit 2
          )`,
      );
    } finally {
      await closeDb(setup);
    }

    await expect(
      runMigrations({ databaseUrl, logger: silentLogger }),
    ).resolves.toEqual({ applied: 2 });

    const verify = createDb(databaseUrl);
    try {
      const identities = await verify.pool.query<{
        account_id: string;
        issuer: string;
        provider_id: string;
      }>(
        `select account_id, issuer, provider_id
           from "account"
          order by provider_id`,
      );
      expect(identities.rows).toEqual([
        {
          account_id: "issuer-credential-user",
          issuer: "local:credential",
          provider_id: "credential",
        },
        {
          account_id: "subject-123",
          issuer: "local:oauth:oidc",
          provider_id: "oidc",
        },
      ]);

      await expect(
        verify.pool.query(
          `insert into "account"
             (id, issuer, account_id, provider_id, user_id, updated_at)
           values
             ('duplicate-issuer-account', 'local:oauth:oidc', 'subject-123', 'oidc', 'issuer-oidc-user', now())`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await closeDb(verify);
    }
  });
});

describe("0033 Better Auth account-issuer ambiguity guard", () => {
  const dbName = scratchDbName("loxep_test_auth_issuer_guard");
  let databaseUrl = "";

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
  });

  afterAll(async () => {
    await dropScratchDb(dbName);
  });

  it("refuses to invent an issuer for an unrecognized legacy provider", async () => {
    await runMigrations({ databaseUrl, logger: silentLogger });

    const setup = createDb(databaseUrl);
    try {
      await setup.pool.query(`drop index "account_issuer_accountId_uidx"`);
      await setup.pool.query(`alter table "account" drop column "issuer"`);
      await setup.pool.query(
        `insert into "user" (id, name, email, updated_at)
         values ('issuer-unknown-user', 'Unknown User', 'issuer-unknown@example.test', now())`,
      );
      await setup.pool.query(
        `insert into "account"
           (id, account_id, provider_id, user_id, updated_at)
         values
           ('issuer-unknown-account', 'external-123', 'unknown-provider', 'issuer-unknown-user', now())`,
      );
      await setup.pool.query(
        `delete from drizzle.__drizzle_migrations
          where created_at in (
            select created_at from drizzle.__drizzle_migrations
            order by created_at desc
            limit 2
          )`,
      );
    } finally {
      await closeDb(setup);
    }

    await expect(
      runMigrations({ databaseUrl, logger: silentLogger }),
    ).rejects.toThrow(/unrecognized provider_id/);

    const verify = createDb(databaseUrl);
    try {
      const issuerColumn = await verify.pool.query(
        `select 1
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'account'
            and column_name = 'issuer'`,
      );
      expect(issuerColumn.rowCount).toBe(0);
    } finally {
      await closeDb(verify);
    }
  });
});
