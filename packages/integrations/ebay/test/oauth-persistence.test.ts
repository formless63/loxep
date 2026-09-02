/**
 * OAuth persistence integration tests (loxep-62y.1.2) against a real scratch
 * PostgreSQL database, following the sibling packages' harness pattern.
 *
 * WHAT IS COVERED: the consent callback's storage half, end to end, with the
 * provider exchange MOCKED (a stubbed adapter — no network). The route in
 * `apps/web/src/routes/api.integrations.ebay.callback.ts` is a thin shell over
 * exactly these steps:
 *
 *   verify state → exchange code → credentialWriteForBundle → store encrypted
 *   credential ('oauth_tokens' purpose) with expires_at/refresh_after →
 *   record connection success → read back → bundleFromCredential
 *
 * plus the `integration.ebay.keyset` application-secret roundtrip and the
 * containment rule (no token/keyset material in plaintext columns, audit
 * rows, or errors).
 *
 * DEPENDENCY NOTE: this TEST (never `src/`) reaches for `@loxep/domain`,
 * `@loxep/db`, and `@loxep/config`, which resolve through the workspace but
 * are not declared in this package's package.json — declaring them as
 * devDependencies is a pending follow-up. `src/` stays dependency-free on
 * purpose: the integration boundary must not depend on the domain layer.
 *
 * ABSOLUTE RULE honored here: every credential/token value is fake, and leak
 * checks are programmatic containment comparisons.
 */
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { parseKeyring } from "@loxep/config";
import { user } from "@loxep/db/schema";
import {
  createConnectionsService,
  createSecretsService,
  type ConnectionsService,
  type SecretsService,
} from "@loxep/domain";
import {
  EBAY_BASE_SCOPE,
  buildConsentState,
  bundleFromCredential,
  credentialWriteForBundle,
  exchangeConsentCode,
  verifyConsentState,
} from "../src/index.ts";
import type { EbayAdapter, EbayUserTokenBundle } from "../src/index.ts";
import { adapterInternals } from "../src/adapter.ts";
import { createEbayAdapter } from "../src/index.ts";

// FAKE values only.
const FAKE_KEYSET = {
  appId: "FakeApp-fakefake-SBX-0123456789ab-cdef0123",
  certId: "SBX-fakefakefake-abcd-1234-5678-9abc",
  devId: "01234567-89ab-cdef-0123-456789abcdef",
  ruName: "Fake_Loxep-FakeApp-fakefa-abcdefghi",
  environment: "sandbox",
} as const;
const FAKE_ACCESS_TOKEN = "PLAINTEXT-MARKER-ebay-access-9c41";
const FAKE_REFRESH_TOKEN = "PLAINTEXT-MARKER-ebay-refresh-2f8d";

const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:loxep-dev@localhost:5433/loxep_test";
const baseDatabaseUrl =
  process.env["LOXEP_TEST_DATABASE_URL"] ?? DEFAULT_TEST_DATABASE_URL;

function databaseUrlFor(databaseName: string): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(baseDatabaseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

async function createScratchDb(databaseName: string): Promise<string> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(
      `create database "${databaseName}" template template0`,
    );
  } finally {
    await closeDb(handle);
  }
  return databaseUrlFor(databaseName);
}

async function dropScratchDb(databaseName: string): Promise<void> {
  const handle = createDb(maintenanceUrl());
  try {
    await handle.pool.query(
      `drop database if exists "${databaseName}" with (force)`,
    );
  } finally {
    await closeDb(handle);
  }
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** ADR-0019 keyring in the real document format. */
function testKeyring() {
  return parseKeyring(
    JSON.stringify({
      active_version: 1,
      keys: { "1": Buffer.alloc(32, 7).toString("base64") },
    }),
  );
}

/** An adapter whose provider exchange is stubbed — no network in this file. */
function adapterWithStubbedExchange(bundleParts: {
  accessToken: string;
  refreshToken: string;
}): EbayAdapter {
  const adapter = createEbayAdapter({ ...FAKE_KEYSET });
  const internals = adapterInternals(adapter);
  internals.client.OAuth2.getToken = (async () => ({
    access_token: bundleParts.accessToken,
    expires_in: 7200,
    refresh_token: bundleParts.refreshToken,
    refresh_token_expires_in: 47304000,
    token_type: "User Access Token",
  })) as unknown as typeof internals.client.OAuth2.getToken;
  return adapter;
}

describe("eBay OAuth persistence (scratch db)", () => {
  const dbName = `loxep_test_ebay_oauth_${randomBytes(4).toString("hex")}`;
  const keyring = testKeyring();
  let handle: DbHandle;
  let connections: ConnectionsService;
  let secrets: SecretsService;
  let actorId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    connections = createConnectionsService({ db: handle.db, keyring });
    secrets = createSecretsService({ db: handle.db, keyring });
    actorId = "user_ebay_oauth_actor";
    await handle.db.insert(user).values({
      id: actorId,
      name: "Test Admin",
      email: `${actorId}@example.test`,
    });
  }, 120_000);

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  async function newConnection(name: string) {
    return connections.createConnection(
      {
        provider: "ebay",
        kind: "marketplace",
        name,
        config: { marketplaceId: "EBAY_US" },
        createdByUserId: actorId,
      },
      { actorUserId: actorId },
    );
  }

  it("stores the keyset as the integration.ebay.keyset application secret", async () => {
    const write = await secrets.setSecret({
      secretKey: "integration.ebay.keyset",
      purpose: "ebay_keyset",
      payload: { ...FAKE_KEYSET },
      actorUserId: actorId,
    });
    expect(write.currentVersion).toBe(1);

    const { purpose, payload } = await secrets.getSecretPayload(
      "integration.ebay.keyset",
      "ebay_keyset",
    );
    expect(purpose).toBe("ebay_keyset");
    expect(payload).toEqual({ ...FAKE_KEYSET });

    // Metadata listing must expose no credential material.
    const listed = (await secrets.listSecrets()).find(
      (entry) => entry.secretKey === "integration.ebay.keyset",
    );
    expect(listed?.purpose).toBe("ebay_keyset");
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(FAKE_KEYSET.certId);
    expect(serialized).not.toContain(FAKE_KEYSET.appId);
  });

  it("rotates the keyset to a new version without losing the pointer", async () => {
    await secrets.setSecret({
      secretKey: "integration.ebay.keyset.rotating",
      purpose: "ebay_keyset",
      payload: { ...FAKE_KEYSET },
      actorUserId: actorId,
    });
    const rotated = await secrets.rotateSecret(
      "integration.ebay.keyset.rotating",
      { ...FAKE_KEYSET, certId: "SBX-rotated-fake-cert-0000" },
      { actorUserId: actorId },
    );
    expect(rotated.currentVersion).toBe(2);
    const { payload } = await secrets.getSecretPayload(
      "integration.ebay.keyset.rotating",
      "ebay_keyset",
    );
    expect(payload.certId).toBe("SBX-rotated-fake-cert-0000");
  });

  it("completes the callback flow: state → exchange → credential → success", async () => {
    const connection = await newConnection("eBay sandbox (callback)");

    // 1. State handshake exactly as the route performs it.
    const state = buildConsentState(connection.id);
    expect(verifyConsentState(state.state, state.nonce).connectionId).toBe(
      connection.id,
    );

    // 2. Mocked provider exchange.
    const adapter = adapterWithStubbedExchange({
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
    });
    const bundle = await exchangeConsentCode(adapter, {
      code: "fake-authorization-code",
    });
    expect(bundle.scopes).toEqual([EBAY_BASE_SCOPE]);

    // 3. Persist through the shared secret/non-secret split.
    const write = credentialWriteForBundle(bundle);
    expect(write.credentialType).toBe("oauth_tokens");
    await connections.setConnectionCredential(
      connection.id,
      write.credentialType,
      write.payload,
      {
        expiresAt: write.expiresAt,
        refreshAfter: write.refreshAfter,
        actorUserId: actorId,
      },
    );
    await connections.updateConnection(
      connection.id,
      {
        config: { ...connection.config, ebayOAuth: write.connectionConfig },
      },
      { actorUserId: actorId },
    );
    const succeeded = await connections.recordConnectionSuccess(connection.id, {
      actorUserId: actorId,
    });
    expect(succeeded.status).toBe("active");
    expect(succeeded.lastSuccessAt).not.toBeNull();

    // 4. Credential metadata carries the refresh schedule.
    const [metadata] = await connections.listConnectionCredentials(
      connection.id,
    );
    expect(metadata?.credentialType).toBe("oauth_tokens");
    expect(metadata?.expiresAt?.toISOString()).toBe(
      write.expiresAt.toISOString(),
    );
    expect(metadata?.refreshAfter?.toISOString()).toBe(
      write.refreshAfter.toISOString(),
    );
    expect(metadata?.refreshAfter!.getTime()).toBeLessThan(
      metadata!.expiresAt!.getTime(),
    );

    // 5. Read back and rebuild the exact bundle the poller will use.
    const stored = await connections.getConnectionCredentialPayload(
      connection.id,
      "oauth_tokens",
    );
    const reloaded = await connections.getConnection(connection.id);
    const oauthConfig = reloaded.config["ebayOAuth"] as {
      scopes: string[];
      refreshTokenExpiresAt: string | null;
    };
    const rebuilt: EbayUserTokenBundle = bundleFromCredential({
      payload: stored.payload,
      expiresAt: metadata?.expiresAt ?? null,
      scopes: oauthConfig.scopes,
      refreshTokenExpiresAt: oauthConfig.refreshTokenExpiresAt,
    });
    expect(rebuilt).toEqual(bundle);
  });

  it("keeps token material out of every plaintext column and audit row", async () => {
    const connection = await newConnection("eBay sandbox (containment)");
    const adapter = adapterWithStubbedExchange({
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
    });
    const bundle = await exchangeConsentCode(adapter, { code: "code" });
    const write = credentialWriteForBundle(bundle);
    await connections.setConnectionCredential(
      connection.id,
      write.credentialType,
      write.payload,
      {
        expiresAt: write.expiresAt,
        refreshAfter: write.refreshAfter,
        actorUserId: actorId,
      },
    );
    await connections.updateConnection(
      connection.id,
      { config: { ebayOAuth: write.connectionConfig } },
      { actorUserId: actorId },
    );

    // Whole-database sweep of the tables this flow writes.
    for (const query of [
      "select * from connections",
      "select * from connection_credentials",
      "select credential_id, version, key_version, expires_at, refresh_after from connection_credential_versions",
      "select * from audit_events",
    ]) {
      const rows = await handle.pool.query(query);
      const serialized = JSON.stringify(rows.rows);
      expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);
      expect(serialized).not.toContain(FAKE_REFRESH_TOKEN);
    }

    // Ciphertext really is ciphertext.
    const versions = await handle.pool.query(
      "select ciphertext from connection_credential_versions",
    );
    for (const row of versions.rows as Array<{ ciphertext: Buffer }>) {
      const text = Buffer.from(row.ciphertext).toString("utf8");
      expect(text).not.toContain(FAKE_ACCESS_TOKEN);
      expect(text).not.toContain(FAKE_REFRESH_TOKEN);
    }
  });

  it("refuses to rebuild a bundle from a credential missing its refresh token", async () => {
    const connection = await newConnection("eBay sandbox (partial)");
    await connections.setConnectionCredential(
      connection.id,
      "oauth_tokens",
      { accessToken: FAKE_ACCESS_TOKEN },
      { expiresAt: new Date(Date.now() + 3600_000), actorUserId: actorId },
    );
    const stored = await connections.getConnectionCredentialPayload(
      connection.id,
      "oauth_tokens",
    );
    const error = ((): unknown => {
      try {
        return bundleFromCredential({
          payload: stored.payload,
          expiresAt: new Date(),
        });
      } catch (thrown) {
        return thrown;
      }
    })();
    expect((error as { kind?: string }).kind).toBe("auth");
    expect(inspect(error, { depth: 8 })).not.toContain(FAKE_ACCESS_TOKEN);
  });

  it("records a failed consent attempt on the connection", async () => {
    const connection = await newConnection("eBay sandbox (failure)");
    const failed = await connections.recordConnectionFailure(
      connection.id,
      { errorCode: "ebay_oauth_auth" },
      { actorUserId: actorId },
    );
    expect(failed.status).toBe("error");
    expect(failed.lastErrorCode).toBe("ebay_oauth_auth");
  });
});
