/**
 * Connection removal lifecycle (loxep-o7h): hard delete when nothing
 * references the connection, archive when something does.
 *
 * The seeded references are chosen deliberately: `monitor_targets` has a real
 * foreign key (the database would refuse the delete on its own), while
 * `marketplace_item_observations` has NONE — its `connection_id` is
 * application-resolved provenance on a hypertable, so only the service's own
 * count stands between an operator and orphaned observation rows. Both must
 * show up in the refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  ConnectionInUseError,
  DomainValidationError,
  createConnectionsService,
} from "../src/index.ts";
import type { ConnectionsService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
  testKeyring,
} from "./helpers.ts";

const MARKER = "PLAINTEXT-MARKER-conn-delete-4f1a";

describe("connection removal lifecycle", () => {
  const dbName = scratchDbName("loxep_test_domain_conn_lifecycle");
  const keyring = testKeyring(1, [1]);
  let handle: DbHandle;
  let service: ConnectionsService;
  let creatorId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createConnectionsService({ db: handle.db, keyring });
    creatorId = await insertTestUser(handle.db, "user_conn_lifecycle");
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  async function createConnection(name: string): Promise<string> {
    const connection = await service.createConnection({
      provider: "ebay",
      kind: "marketplace",
      name,
      createdByUserId: creatorId,
    });
    return connection.id;
  }

  it("counts zero references for a fresh connection", async () => {
    const id = await createConnection("Unreferenced account");
    const references = await service.countConnectionReferences(id);
    expect(references.total).toBe(0);
    expect(references.blocking).toEqual([]);
    // Every referencing table is enumerated, not just the non-zero ones.
    expect(references.counts.map((entry) => entry.table)).toContain("orders");
    expect(references.counts.map((entry) => entry.table)).toContain(
      "marketplace_item_observations",
    );
  });

  it("hard-deletes an unreferenced connection with its credential rows", async () => {
    const id = await createConnection("Deletable account");
    await service.setConnectionCredential(
      id,
      "oauth_tokens",
      { accessToken: MARKER, refreshToken: `${MARKER}-refresh` },
      { actorUserId: creatorId },
    );
    // A rotation, so more than one version row exists to clean up.
    await service.setConnectionCredential(
      id,
      "oauth_tokens",
      { accessToken: `${MARKER}-2` },
      { actorUserId: creatorId },
    );

    const result = await service.deleteConnection(id, {
      actorUserId: creatorId,
      requestId: "req-conn-delete",
    });
    expect(result.deletedCredentials).toBe(1);
    expect(result.deletedCredentialVersions).toBe(2);

    const rows = await handle.pool.query(
      "select id from connections where id = $1",
      [id],
    );
    expect(rows.rowCount).toBe(0);
    // Secret hygiene: no ciphertext survives a deleted account.
    const credentials = await handle.pool.query(
      "select id from connection_credentials where connection_id = $1",
      [id],
    );
    expect(credentials.rowCount).toBe(0);
    const versions = await handle.pool.query(
      "select credential_id from connection_credential_versions",
    );
    expect(versions.rowCount).toBe(0);

    const audits = await handle.pool.query<{
      action: string;
      after: unknown;
      metadata: { deletedCredentials?: number };
    }>(
      "select * from audit_events where resource_id = $1 and action = 'connection.delete'",
      [id],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0]?.after).toBeNull();
    expect(audits.rows[0]?.metadata.deletedCredentials).toBe(1);
    expect(JSON.stringify(audits.rows)).not.toContain(MARKER);
  });

  it("refuses to delete a referenced connection and reports per-table counts", async () => {
    const id = await createConnection("Referenced account");
    await handle.pool.query(
      `insert into monitor_targets (connection_id, target_type, name, interval_seconds)
       values ($1, 'ebay_watchlist', 'watchlist', 900)`,
      [id],
    );
    // No foreign key here — the count is the ONLY thing protecting these rows.
    await handle.pool.query(
      `insert into marketplace_item_observations
         (marketplace_item_id, observed_at, observation_batch_id, connection_id, source)
       values (gen_random_uuid(), now(), gen_random_uuid(), $1, 'test'),
              (gen_random_uuid(), now(), gen_random_uuid(), $1, 'test')`,
      [id],
    );

    const references = await service.countConnectionReferences(id);
    expect(references.total).toBe(3);
    expect(
      references.blocking.find((entry) => entry.table === "monitor_targets")
        ?.count,
    ).toBe(1);
    expect(
      references.blocking.find(
        (entry) => entry.table === "marketplace_item_observations",
      )?.count,
    ).toBe(2);

    const error = await service
      .deleteConnection(id, { actorUserId: creatorId })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(ConnectionInUseError);
    const inUse = error as ConnectionInUseError;
    expect(inUse.total).toBe(3);
    expect(inUse.references.map((entry) => entry.table).sort()).toEqual([
      "marketplace_item_observations",
      "monitor_targets",
    ]);

    // The refusal is a no-op: nothing was deleted on the way out.
    const rows = await handle.pool.query(
      "select status from connections where id = $1",
      [id],
    );
    expect(rows.rowCount).toBe(1);
    const audits = await handle.pool.query(
      "select id from audit_events where resource_id = $1 and action = 'connection.delete'",
      [id],
    );
    expect(audits.rowCount).toBe(0);
  });

  it("archives a referenced connection and audits the transition", async () => {
    const id = await createConnection("Archivable account");
    await handle.pool.query(
      `insert into monitor_targets (connection_id, target_type, name, interval_seconds)
       values ($1, 'ebay_watchlist', 'watchlist', 900)`,
      [id],
    );

    const archived = await service.archiveConnection(id, {
      actorUserId: creatorId,
      requestId: "req-conn-archive",
    });
    expect(archived.status).toBe("archived");

    const stored = await handle.pool.query<{ status: string }>(
      "select status from connections where id = $1",
      [id],
    );
    expect(stored.rows[0]?.status).toBe("archived");

    const audits = await handle.pool.query<{
      action: string;
      before: { status?: string };
      after: { status?: string };
    }>(
      "select * from audit_events where resource_id = $1 and action = 'connection.archive'",
      [id],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0]?.before.status).toBe("active");
    expect(audits.rows[0]?.after.status).toBe("archived");

    // Archived is terminal: provider outcomes never resurrect it.
    const afterSuccess = await service.recordConnectionSuccess(id);
    expect(afterSuccess.status).toBe("archived");
    const afterFailure = await service.recordConnectionFailure(id, {
      errorCode: "IGNORED_WHILE_ARCHIVED",
    });
    expect(afterFailure.status).toBe("archived");

    // Archived accounts are excluded from a status-filtered listing.
    const active = await service.listConnections({ status: "active" });
    expect(active.some((connection) => connection.id === id)).toBe(false);
    const archivedList = await service.listConnections({ status: "archived" });
    expect(archivedList.some((connection) => connection.id === id)).toBe(true);
  });

  it("unarchives to disabled, never straight back to active", async () => {
    const id = await createConnection("Restorable account");
    await service.archiveConnection(id, { actorUserId: creatorId });

    const restored = await service.unarchiveConnection(id, {
      actorUserId: creatorId,
    });
    expect(restored.status).toBe("disabled");

    const audits = await handle.pool.query<{ after: { status?: string } }>(
      "select * from audit_events where resource_id = $1 and action = 'connection.unarchive'",
      [id],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0]?.after.status).toBe("disabled");

    // Un-archiving something that is not archived is a mistake, not a no-op.
    await expect(service.unarchiveConnection(id)).rejects.toBeInstanceOf(
      DomainValidationError,
    );
  });
});
