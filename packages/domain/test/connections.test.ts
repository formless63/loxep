/**
 * Connections service integration tests: in-app connection lifecycle with
 * status text-union and config validation, success/failure recording with
 * status transitions, credential set/get roundtrip through the ADR-0019
 * encrypted credentials service, and redacted audit events for every
 * mutation. Removal (delete when unreferenced, archive when not) has its own
 * file: `connection-lifecycle.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  ConnectionNotFoundError,
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

const MARKER = "PLAINTEXT-MARKER-conn-cred-9b7c";
const MISSING_ID = "00000000-0000-4000-8000-00000000dead";

describe("connections service", () => {
  const dbName = scratchDbName("loxep_test_domain_connections");
  const keyring = testKeyring(1, [1]);
  let handle: DbHandle;
  let service: ConnectionsService;
  let creatorId: string;
  let connectionId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createConnectionsService({
      db: handle.db,
      keyring,
      configSchemas: {
        // Pluggable per-provider schema: exercised by the strict-config test.
        woocommerce: z.strictObject({ storeUrl: z.url() }),
      },
    });
    creatorId = await insertTestUser(handle.db, "user_connections_creator");
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("creates a connection with default active status and provenance", async () => {
    const connection = await service.createConnection(
      {
        provider: "ebay",
        kind: "marketplace",
        name: "eBay store",
        config: { marketplaceId: "EBAY_US" },
        externalAccountId: "ebay-user-1",
        createdByUserId: creatorId,
      },
      { requestId: "req-conn-1" },
    );
    connectionId = connection.id;
    expect(connection.status).toBe("active");
    expect(connection.createdByUserId).toBe(creatorId);
    expect(connection.economicEntityId).toBeNull();

    const stored = await handle.pool.query<{
      status: string;
      created_by_user_id: string;
      config: { marketplaceId?: string };
    }>("select * from connections where id = $1", [connection.id]);
    expect(stored.rows[0]?.status).toBe("active");
    expect(stored.rows[0]?.created_by_user_id).toBe(creatorId);
    expect(stored.rows[0]?.config.marketplaceId).toBe("EBAY_US");
  });

  it("rejects a status outside the text union", async () => {
    await expect(
      service.createConnection({
        provider: "ebay",
        kind: "marketplace",
        name: "Bad status",
        status: "paused" as never,
        createdByUserId: creatorId,
      }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    await expect(
      service.setConnectionStatus(connectionId, "paused" as never),
    ).rejects.toBeInstanceOf(DomainValidationError);
  });

  it("validates config through the pluggable per-provider schema", async () => {
    await expect(
      service.createConnection({
        provider: "woocommerce",
        kind: "store",
        name: "Woo store",
        config: { storeUrl: "not a url" },
        createdByUserId: creatorId,
      }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    // Generic providers accept any JSON object.
    const generic = await service.createConnection({
      provider: "custom",
      kind: "service",
      name: "Generic service",
      config: { anything: { nested: true } },
      createdByUserId: creatorId,
    });
    expect(generic.config).toEqual({ anything: { nested: true } });
  });

  it("updates name and config, validating against the stored provider", async () => {
    const updated = await service.updateConnection(
      connectionId,
      { name: "eBay main store", config: { marketplaceId: "EBAY_DE" } },
      { actorUserId: creatorId },
    );
    expect(updated.name).toBe("eBay main store");
    expect(updated.config).toEqual({ marketplaceId: "EBAY_DE" });
    await expect(
      service.updateConnection(MISSING_ID, { name: "ghost" }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("records failure: last_error fields set and active moves to error", async () => {
    const failed = await service.recordConnectionFailure(
      connectionId,
      { errorCode: "OAUTH_EXPIRED" },
      { actorUserId: creatorId },
    );
    expect(failed.status).toBe("error");
    expect(failed.lastErrorCode).toBe("OAUTH_EXPIRED");
    expect(failed.lastErrorAt).not.toBeNull();
  });

  it("records success: last_success_at set and error moves back to active", async () => {
    const recovered = await service.recordConnectionSuccess(connectionId, {
      actorUserId: creatorId,
    });
    expect(recovered.status).toBe("active");
    expect(recovered.lastSuccessAt).not.toBeNull();
    // Historical error fields survive recovery.
    expect(recovered.lastErrorCode).toBe("OAUTH_EXPIRED");
  });

  it("disabled connections stay disabled through success/failure recording", async () => {
    const disabled = await service.setConnectionStatus(
      connectionId,
      "disabled",
      { actorUserId: creatorId },
    );
    expect(disabled.status).toBe("disabled");
    const afterFailure = await service.recordConnectionFailure(connectionId, {
      errorCode: "IGNORED_WHILE_DISABLED",
    });
    expect(afterFailure.status).toBe("disabled");
    const afterSuccess = await service.recordConnectionSuccess(connectionId);
    expect(afterSuccess.status).toBe("disabled");
    await service.setConnectionStatus(connectionId, "active");
  });

  it("lists connections with provider/status filters", async () => {
    const all = await service.listConnections();
    expect(all.length).toBeGreaterThanOrEqual(2);
    const ebay = await service.listConnections({ provider: "ebay" });
    expect(ebay.every((c) => c.provider === "ebay")).toBe(true);
    const active = await service.listConnections({ status: "active" });
    expect(active.some((c) => c.id === connectionId)).toBe(true);
  });

  it("roundtrips an encrypted credential bundle through the credentials service", async () => {
    await expect(
      service.setConnectionCredential(MISSING_ID, "oauth_tokens", {
        accessToken: MARKER,
      }),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);

    const written = await service.setConnectionCredential(
      connectionId,
      "oauth_tokens",
      { accessToken: MARKER, refreshToken: `${MARKER}-refresh` },
      { actorUserId: creatorId },
    );
    expect(written.currentVersion).toBe(1);

    const { purpose, payload } = await service.getConnectionCredentialPayload(
      connectionId,
      "oauth_tokens",
    );
    expect(purpose).toBe("oauth_tokens");
    expect(payload.accessToken).toBe(MARKER);

    // Stored ciphertext only — the plaintext marker appears nowhere.
    const versions = await handle.pool.query<{ ciphertext: Buffer }>(
      "select * from connection_credential_versions",
    );
    expect(versions.rowCount).toBe(1);
    expect(
      versions.rows[0]?.ciphertext.toString("utf8").includes(MARKER),
    ).toBe(false);

    const metadata = await service.listConnectionCredentials(connectionId);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.credentialType).toBe("oauth_tokens");
    expect(JSON.stringify(metadata)).not.toContain(MARKER);
  });

  it("exposes the guarded removal lifecycle (loxep-o7h)", () => {
    // Removal exists, but only through the reference-guarded pair; the
    // behavior itself lives in `connection-lifecycle.test.ts`.
    expect(typeof service.deleteConnection).toBe("function");
    expect(typeof service.archiveConnection).toBe("function");
    expect(typeof service.unarchiveConnection).toBe("function");
    expect(typeof service.countConnectionReferences).toBe("function");
  });

  it("wrote redacted audit events for every mutation", async () => {
    const audits = await handle.pool.query<{
      action: string;
      resource_id: string;
      metadata: { errorCode?: string };
    }>(
      `select * from audit_events
        where resource_type in ('connection', 'connection_credential')
        order by occurred_at asc`,
    );
    const actions = audits.rows.map((row) => row.action);
    expect(actions.filter((a) => a === "connection.create")).toHaveLength(2);
    expect(actions).toContain("connection.update");
    expect(actions).toContain("connection.set_status");
    expect(actions).toContain("connection.record_success");
    expect(actions).toContain("connection.record_failure");
    expect(actions).toContain("connection_credential.create");

    const failure = audits.rows.find(
      (row) => row.action === "connection.record_failure",
    );
    expect(failure?.metadata.errorCode).toBe("OAUTH_EXPIRED");

    // Redaction intact: no plaintext credential material in any audit row.
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain(MARKER);
  });
});
