/**
 * Application secrets service integration tests: logical row + immutable
 * versions, current_version pointer semantics, AAD context binding, and the
 * no-plaintext-anywhere rule (ADR-0016, ADR-0019).
 */
import { Buffer } from "node:buffer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  BundleValidationError,
  SecretCipherError,
  SecretNotFoundError,
  SecretsServiceError,
  applicationSecretAad,
  createSecretCipher,
  createSecretsService,
} from "../src/index.ts";
import type { SecretsService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
  testKeyring,
} from "./helpers.ts";

const MARKER_V1 = "PLAINTEXT-MARKER-secret-v1-7f3e";
const MARKER_V2 = "PLAINTEXT-MARKER-secret-v2-a1b9";
const MARKER_OTHER = "PLAINTEXT-MARKER-other-44c2";

interface SecretVersionRow {
  secret_id: string;
  version: number;
  key_version: number;
  nonce: Buffer;
  auth_tag: Buffer;
  ciphertext: Buffer;
}

describe("secrets service", () => {
  const dbName = scratchDbName("loxep_test_domain_secrets");
  const keyring = testKeyring(1, [1]);
  let handle: DbHandle;
  let service: SecretsService;
  let actorId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createSecretsService({ db: handle.db, keyring });
    actorId = await insertTestUser(handle.db, "user_secrets_actor");
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("first write creates the logical row and version 1", async () => {
    const result = await service.setSecret({
      secretKey: "storage.s3.primary",
      purpose: "s3_credentials",
      payload: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: MARKER_V1 },
      actorUserId: actorId,
      requestId: "req-secret-1",
    });
    expect(result.currentVersion).toBe(1);
    expect(result.keyVersion).toBe(1);

    const logical = await handle.pool.query<{
      current_version: number;
      purpose: string;
      created_by_user_id: string;
    }>("select * from application_secrets where secret_key = $1", [
      "storage.s3.primary",
    ]);
    expect(logical.rowCount).toBe(1);
    expect(logical.rows[0]?.current_version).toBe(1);
    expect(logical.rows[0]?.purpose).toBe("s3_credentials");
    expect(logical.rows[0]?.created_by_user_id).toBe(actorId);

    const versions = await handle.pool.query(
      "select * from application_secret_versions where secret_id = $1",
      [result.id],
    );
    expect(versions.rowCount).toBe(1);
  });

  it("returns the typed bundle from the current version", async () => {
    const { purpose, payload } = await service.getSecretPayload(
      "storage.s3.primary",
      "s3_credentials",
    );
    expect(purpose).toBe("s3_credentials");
    expect(payload).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: MARKER_V1,
    });
  });

  it("rotation bumps the version and pointer, keeping the old version intact and decryptable", async () => {
    const result = await service.rotateSecret(
      "storage.s3.primary",
      { accessKeyId: "AKIAEXAMPLE2", secretAccessKey: MARKER_V2 },
      { actorUserId: actorId },
    );
    expect(result.currentVersion).toBe(2);

    const versions = await handle.pool.query<SecretVersionRow>(
      `select * from application_secret_versions
        where secret_id = $1 order by version asc`,
      [result.id],
    );
    expect(versions.rowCount).toBe(2);

    // Current read returns the new payload only.
    const current = await service.getSecretPayload(
      "storage.s3.primary",
      "s3_credentials",
    );
    expect(current.payload.secretAccessKey).toBe(MARKER_V2);

    // The old version row is immutable, intact, and still decryptable with
    // its own AAD (re-encryption jobs need this).
    const oldRow = versions.rows[0];
    expect(oldRow?.version).toBe(1);
    const cipher = createSecretCipher(keyring);
    const plaintext = cipher.decrypt(
      {
        keyVersion: oldRow?.key_version ?? -1,
        nonce: oldRow?.nonce ?? Buffer.alloc(0),
        authTag: oldRow?.auth_tag ?? Buffer.alloc(0),
        ciphertext: oldRow?.ciphertext ?? Buffer.alloc(0),
      },
      applicationSecretAad(result.id, 1, oldRow?.key_version ?? -1),
    );
    expect(JSON.parse(Buffer.from(plaintext).toString("utf8"))).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: MARKER_V1,
    });
  });

  it("rejects a write whose purpose conflicts with the existing secret", async () => {
    await expect(
      service.setSecret({
        secretKey: "storage.s3.primary",
        purpose: "token",
        payload: { token: MARKER_OTHER },
      }),
    ).rejects.toBeInstanceOf(SecretsServiceError);
  });

  it("rejects invalid bundles before persistence without echoing values", async () => {
    let caught: unknown;
    try {
      await service.setSecret({
        secretKey: "notify.ntfy",
        purpose: "token",
        // Invalid: missing `token`, unrecognized key carrying the marker.
        payload: { bogus: MARKER_OTHER } as unknown as { token: string },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BundleValidationError);
    expect((caught as Error).message).not.toContain(MARKER_OTHER);

    const rows = await handle.pool.query(
      "select * from application_secrets where secret_key = $1",
      ["notify.ntfy"],
    );
    expect(rows.rowCount).toBe(0);
  });

  it("throws SecretNotFoundError for unknown secrets", async () => {
    await expect(service.getSecretPayload("does.not.exist")).rejects.toBeInstanceOf(
      SecretNotFoundError,
    );
    await expect(
      service.rotateSecret("does.not.exist", { token: "x" }, {}),
    ).rejects.toBeInstanceOf(SecretNotFoundError);
  });

  it("fails decryption when ciphertext is swapped between records (AAD binding)", async () => {
    const a = await service.setSecret({
      secretKey: "swap.a",
      purpose: "token",
      payload: { token: MARKER_OTHER },
    });
    const b = await service.setSecret({
      secretKey: "swap.b",
      purpose: "token",
      payload: { token: "unremarkable-token-value" },
    });

    // Copy A's entire encrypted record (nonce, tag, ciphertext, key version)
    // onto B's current version row in SQL — everything an attacker moving
    // rows could move.
    await handle.pool.query(
      `update application_secret_versions b
          set nonce = a.nonce,
              auth_tag = a.auth_tag,
              ciphertext = a.ciphertext,
              key_version = a.key_version
         from application_secret_versions a
        where a.secret_id = $1 and a.version = $2
          and b.secret_id = $3 and b.version = $4`,
      [a.id, a.currentVersion, b.id, b.currentVersion],
    );

    let caught: unknown;
    try {
      await service.getSecretPayload("swap.b");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretCipherError);
    expect((caught as Error).message).not.toContain(MARKER_OTHER);
    // A's own record still decrypts fine.
    const intact = await service.getSecretPayload("swap.a", "token");
    expect(intact.payload.token).toBe(MARKER_OTHER);
  });

  it("lists metadata only — never payload or ciphertext material", async () => {
    const list = await service.listSecrets();
    const primary = list.find(
      (entry) => entry.secretKey === "storage.s3.primary",
    );
    expect(primary).toMatchObject({
      purpose: "s3_credentials",
      currentVersion: 2,
      keyVersion: 1,
    });
    expect(primary?.createdAt).toBeInstanceOf(Date);
    expect(primary?.currentVersionCreatedAt).toBeInstanceOf(Date);

    const serialized = JSON.stringify(list);
    for (const marker of [MARKER_V1, MARKER_V2, MARKER_OTHER]) {
      expect(serialized).not.toContain(marker);
    }
    for (const field of ["ciphertext", "nonce", "authTag", "payload"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it("writes redacted audit events that never contain plaintext", async () => {
    const audits = await handle.pool.query<{
      action: string;
      resource_type: string;
      metadata: { secretKey?: string; purpose?: string; version?: number };
      before: unknown;
      after: unknown;
    }>(
      "select * from audit_events where resource_type = 'application_secret' order by occurred_at asc",
    );
    expect(audits.rowCount).toBeGreaterThanOrEqual(4);

    const actions = audits.rows.map((row) => row.action);
    expect(actions).toContain("secret.create");
    expect(actions).toContain("secret.rotate");

    const rotate = audits.rows.find((row) => row.action === "secret.rotate");
    expect(rotate?.metadata).toMatchObject({
      secretKey: "storage.s3.primary",
      purpose: "s3_credentials",
      version: 2,
    });
    expect(rotate?.before).toEqual({ currentVersion: 1 });
    expect(rotate?.after).toEqual({ currentVersion: 2, keyVersion: 1 });

    const serialized = JSON.stringify(audits.rows);
    for (const marker of [MARKER_V1, MARKER_V2, MARKER_OTHER]) {
      expect(serialized).not.toContain(marker);
    }
  });
});
