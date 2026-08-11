/**
 * Connection credentials service integration tests: same logical/version/
 * pointer model as application secrets, keyed by (connection_id,
 * credential_type), with expiry/refresh metadata on version rows (ADR-0019).
 */
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { connections } from "@loxep/db/schema";
import {
  SecretCipherError,
  SecretNotFoundError,
  connectionCredentialAad,
  createConnectionCredentialsService,
  createSecretCipher,
} from "../src/index.ts";
import type { ConnectionCredentialsService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
  testKeyring,
} from "./helpers.ts";

const MARKER_V1 = "PLAINTEXT-MARKER-cred-v1-1d2e";
const MARKER_V2 = "PLAINTEXT-MARKER-cred-v2-3f4a";

describe("connection credentials service", () => {
  const dbName = scratchDbName("loxep_test_domain_credentials");
  const keyring = testKeyring(1, [1]);
  let handle: DbHandle;
  let service: ConnectionCredentialsService;
  let actorId: string;
  let connectionId: string;
  let otherConnectionId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createConnectionCredentialsService({ db: handle.db, keyring });
    actorId = await insertTestUser(handle.db, "user_credentials_actor");
    const inserted = await handle.db
      .insert(connections)
      .values([
        {
          provider: "ebay",
          kind: "marketplace",
          name: "eBay test connection",
          status: "active",
          createdByUserId: actorId,
        },
        {
          provider: "ebay",
          kind: "marketplace",
          name: "eBay other connection",
          status: "active",
          createdByUserId: actorId,
        },
      ])
      .returning({ id: connections.id });
    connectionId = inserted[0]?.id ?? "";
    otherConnectionId = inserted[1]?.id ?? "";
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("first write creates the logical row and version 1 with expiry fields", async () => {
    const expiresAt = new Date("2026-12-01T00:00:00Z");
    const refreshAfter = new Date("2026-11-01T00:00:00Z");
    const result = await service.setCredential({
      connectionId,
      credentialType: "oauth_tokens",
      payload: { accessToken: MARKER_V1, refreshToken: `${MARKER_V1}-refresh` },
      expiresAt,
      refreshAfter,
      actorUserId: actorId,
      requestId: "req-cred-1",
    });
    expect(result.currentVersion).toBe(1);
    expect(result.keyVersion).toBe(1);

    const logical = await handle.pool.query<{ current_version: number }>(
      `select * from connection_credentials
        where connection_id = $1 and credential_type = 'oauth_tokens'`,
      [connectionId],
    );
    expect(logical.rowCount).toBe(1);
    expect(logical.rows[0]?.current_version).toBe(1);

    const versions = await handle.pool.query<{
      expires_at: Date;
      refresh_after: Date;
    }>(
      "select * from connection_credential_versions where credential_id = $1",
      [result.id],
    );
    expect(versions.rowCount).toBe(1);
    expect(versions.rows[0]?.expires_at?.toISOString()).toBe(
      expiresAt.toISOString(),
    );
    expect(versions.rows[0]?.refresh_after?.toISOString()).toBe(
      refreshAfter.toISOString(),
    );
  });

  it("returns the typed bundle from the current version", async () => {
    const { purpose, payload } = await service.getCredentialPayload(
      connectionId,
      "oauth_tokens",
    );
    expect(purpose).toBe("oauth_tokens");
    expect(payload.accessToken).toBe(MARKER_V1);
    expect(payload.refreshToken).toBe(`${MARKER_V1}-refresh`);
  });

  it("rotation bumps version and pointer, old version stays intact and decryptable", async () => {
    const newExpiry = new Date("2027-01-15T00:00:00Z");
    const result = await service.rotateCredential(
      connectionId,
      "oauth_tokens",
      { accessToken: MARKER_V2 },
      { expiresAt: newExpiry, actorUserId: actorId },
    );
    expect(result.currentVersion).toBe(2);

    const versions = await handle.pool.query<{
      version: number;
      key_version: number;
      nonce: Buffer;
      auth_tag: Buffer;
      ciphertext: Buffer;
      expires_at: Date | null;
    }>(
      `select * from connection_credential_versions
        where credential_id = $1 order by version asc`,
      [result.id],
    );
    expect(versions.rowCount).toBe(2);

    const current = await service.getCredentialPayload(
      connectionId,
      "oauth_tokens",
    );
    expect(current.payload.accessToken).toBe(MARKER_V2);
    expect(current.payload.refreshToken).toBeUndefined();

    const oldRow = versions.rows[0];
    const cipher = createSecretCipher(keyring);
    const plaintext = cipher.decrypt(
      {
        keyVersion: oldRow?.key_version ?? -1,
        nonce: oldRow?.nonce ?? Buffer.alloc(0),
        authTag: oldRow?.auth_tag ?? Buffer.alloc(0),
        ciphertext: oldRow?.ciphertext ?? Buffer.alloc(0),
      },
      connectionCredentialAad(result.id, 1, oldRow?.key_version ?? -1),
    );
    expect(
      JSON.parse(Buffer.from(plaintext).toString("utf8")).accessToken,
    ).toBe(MARKER_V1);
  });

  it("scopes credentials to (connectionId, credentialType)", async () => {
    await service.setCredential({
      connectionId: otherConnectionId,
      credentialType: "token",
      payload: { token: "other-connection-token" },
    });
    await expect(
      service.getCredentialPayload(otherConnectionId, "oauth_tokens"),
    ).rejects.toBeInstanceOf(SecretNotFoundError);

    const scoped = await service.listCredentials(otherConnectionId);
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.credentialType).toBe("token");
  });

  it("fails decryption when ciphertext is swapped between credentials (AAD binding)", async () => {
    const target = await service.listCredentials(connectionId);
    const source = await service.listCredentials(otherConnectionId);
    const targetCredential = target.find(
      (entry) => entry.credentialType === "oauth_tokens",
    );
    await handle.pool.query(
      `update connection_credential_versions b
          set nonce = a.nonce,
              auth_tag = a.auth_tag,
              ciphertext = a.ciphertext,
              key_version = a.key_version
         from connection_credential_versions a
        where a.credential_id = $1 and a.version = $2
          and b.credential_id = $3 and b.version = $4`,
      [
        source[0]?.id,
        source[0]?.currentVersion,
        targetCredential?.id,
        targetCredential?.currentVersion,
      ],
    );
    await expect(
      service.getCredentialPayload(connectionId, "oauth_tokens"),
    ).rejects.toBeInstanceOf(SecretCipherError);
    // Restore by rotating a fresh version so later assertions stay valid.
    await service.rotateCredential(
      connectionId,
      "oauth_tokens",
      { accessToken: MARKER_V2 },
      { actorUserId: actorId },
    );
  });

  it("lists metadata (incl. expiry) but never payload material", async () => {
    const list = await service.listCredentials();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(list);
    for (const marker of [MARKER_V1, MARKER_V2, "other-connection-token"]) {
      expect(serialized).not.toContain(marker);
    }
    for (const field of ["ciphertext", "nonce", "authTag", "payload"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it("writes redacted audit events carrying metadata and expiry only", async () => {
    const audits = await handle.pool.query<{
      action: string;
      metadata: { connectionId?: string; credentialType?: string };
      after: { expiresAt?: string | null };
    }>(
      "select * from audit_events where resource_type = 'connection_credential' order by occurred_at asc",
    );
    expect(audits.rowCount).toBeGreaterThanOrEqual(3);
    expect(audits.rows[0]?.action).toBe("connection_credential.create");
    expect(audits.rows[0]?.metadata).toMatchObject({
      connectionId,
      credentialType: "oauth_tokens",
    });
    expect(audits.rows[0]?.after.expiresAt).toBe("2026-12-01T00:00:00.000Z");

    const serialized = JSON.stringify(audits.rows);
    for (const marker of [MARKER_V1, MARKER_V2, "other-connection-token"]) {
      expect(serialized).not.toContain(marker);
    }
  });
});
