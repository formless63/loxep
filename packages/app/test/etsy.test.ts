/**
 * `createEtsyAdapterFactory` (loxep-g4t.1): the ONE property that matters
 * most here is the SHARED-PER-APPLICATION rate budget/adapter — the load-
 * bearing divergence from `createEbayAdapterFactory`/`createWooAdapterFactory`
 * (see `etsy.ts`'s module doc). Every other behavior (keyset precedence,
 * shop-id resolution, per-connection caching) mirrors the eBay/Woo factory
 * tests already in this directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import {
  createConnectionCredentialsService,
  createConnectionsService,
  createSecretsService,
} from "@loxep/domain";
import type {
  ConnectionCredentialsService,
  ConnectionsService,
  SecretsService,
} from "@loxep/domain";
import { EtsyKeysetMissingError, createEtsyAdapterFactory } from "../src/index.ts";
import type { EtsyAdapter } from "../../integrations/etsy/src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, testKeyring } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_etsy");
let handle: DbHandle;
let secrets: SecretsService;
let connections: ConnectionsService;
let connectionCredentials: ConnectionCredentialsService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  handle = createDb(databaseUrl);
  const keyring = testKeyring();
  secrets = createSecretsService({ db: handle.db, keyring });
  connections = createConnectionsService({ db: handle.db, keyring });
  connectionCredentials = createConnectionCredentialsService({ db: handle.db, keyring });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "etsy-factory@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

async function storeFakeKeyset(): Promise<void> {
  await secrets.setSecret({
    secretKey: "integration.etsy.keyset",
    purpose: "etsy_keyset",
    payload: { keystring: "fake-keystring", sharedSecret: "fake-shared-secret" },
    actorUserId: "test-user",
  });
}

async function createEtsyConnection(shopExternalId: string): Promise<string> {
  const connection = await connections.createConnection({
    provider: "etsy",
    kind: "marketplace_account",
    name: `shop ${shopExternalId}`,
    config: { etsy: { shopExternalId } },
    createdByUserId: "test-user",
  });
  return connection.id;
}

describe("createEtsyAdapterFactory — shared-per-application budget/adapter", () => {
  it("builds the SAME EtsyAdapter instance for two different connections", async () => {
    await storeFakeKeyset();
    let constructions = 0;
    const fakeAdapter = {} as EtsyAdapter;
    const factory = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      createAdapter: () => {
        constructions += 1;
        return fakeAdapter;
      },
    });

    const connectionA = await createEtsyConnection("11111");
    const connectionB = await createEtsyConnection("22222");

    const adapterA = await factory.getAdapterForConnection(connectionA);
    const adapterB = await factory.getAdapterForConnection(connectionB);

    // ONE shared construction for the whole factory — the entire point.
    expect(constructions).toBe(1);
    expect(adapterA.application).toBe(fakeAdapter);
    expect(adapterB.application).toBe(fakeAdapter);
    expect(adapterA.application).toBe(adapterB.application);
  });

  it("does not rebuild the shared adapter on repeated lookups of the same connection", async () => {
    await storeFakeKeyset();
    let constructions = 0;
    const factory = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      createAdapter: () => {
        constructions += 1;
        return {} as EtsyAdapter;
      },
    });
    const connectionId = await createEtsyConnection("33333");
    await factory.getAdapterForConnection(connectionId);
    await factory.getAdapterForConnection(connectionId);
    await factory.getAdapterForConnection(connectionId);
    expect(constructions).toBe(1);
  });

  it("rebuilds the shared adapter when an explicit rate budget differs from the default", async () => {
    await storeFakeKeyset();
    let constructions = 0;
    const factoryDefault = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      createAdapter: () => {
        constructions += 1;
        return {} as EtsyAdapter;
      },
    });
    const factoryTight = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      rateBudget: { capacity: 1, refillPerSecond: 1 },
      createAdapter: () => {
        constructions += 1;
        return {} as EtsyAdapter;
      },
    });
    const connectionId = await createEtsyConnection("44444");
    await factoryDefault.getAdapterForConnection(connectionId);
    await factoryTight.getAdapterForConnection(connectionId);
    // Two SEPARATE factory instances each build their own shared adapter
    // once — the point is that within ONE factory it never multiplies per
    // connection.
    expect(constructions).toBe(2);
  });
});

describe("createEtsyAdapterFactory — keyset resolution", () => {
  it("throws EtsyKeysetMissingError when no keyset is configured", async () => {
    const emptyDbName = scratchDbName("loxep_test_app_etsy_nokeyset");
    const databaseUrl = await createScratchDb(emptyDbName);
    await runMigrations({ databaseUrl, logger: { info: () => {}, warn: () => {}, error: () => {} } });
    const emptyHandle = createDb(databaseUrl);
    try {
      const keyring = testKeyring();
      const localSecrets = createSecretsService({ db: emptyHandle.db, keyring });
      const localConnections = createConnectionsService({ db: emptyHandle.db, keyring });
      const localCredentials = createConnectionCredentialsService({ db: emptyHandle.db, keyring });
      await emptyHandle.db.insert(user).values({
        id: "test-user",
        name: "Test User",
        email: "etsy-nokeyset@example.invalid",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const connection = await localConnections.createConnection({
        provider: "etsy",
        kind: "marketplace_account",
        name: "shop with no keyset",
        config: { etsy: { shopExternalId: "1" } },
        createdByUserId: "test-user",
      });
      const factory = createEtsyAdapterFactory({
        db: emptyHandle.db,
        secrets: localSecrets,
        connections: localConnections,
        connectionCredentials: localCredentials,
        createAdapter: () => ({}) as EtsyAdapter,
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(EtsyKeysetMissingError);
    } finally {
      await closeDb(emptyHandle);
      await dropScratchDb(emptyDbName);
    }
  });

  it("throws when the connection has no shop id in its config", async () => {
    await storeFakeKeyset();
    const factory = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      createAdapter: () => ({}) as EtsyAdapter,
    });
    const connection = await connections.createConnection({
      provider: "etsy",
      kind: "marketplace_account",
      name: "shop with no id",
      createdByUserId: "test-user",
    });
    await expect(
      factory.getAdapterForConnection(connection.id),
    ).rejects.toThrowError(EtsyKeysetMissingError);
  });

  it("throws when the connection's provider is not 'etsy'", async () => {
    await storeFakeKeyset();
    const factory = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      createAdapter: () => ({}) as EtsyAdapter,
    });
    const connection = await connections.createConnection({
      provider: "ebay",
      kind: "marketplace_account",
      name: "wrong provider",
      createdByUserId: "test-user",
    });
    await expect(
      factory.getAdapterForConnection(connection.id),
    ).rejects.toThrowError(EtsyKeysetMissingError);
  });

  it("resolves the shop id from connections.config.etsy.shopExternalId", async () => {
    await storeFakeKeyset();
    const factory = createEtsyAdapterFactory({
      db: handle.db,
      secrets,
      connections,
      connectionCredentials,
      createAdapter: () => ({}) as EtsyAdapter,
    });
    const connectionId = await createEtsyConnection("987654");
    const adapter = await factory.getAdapterForConnection(connectionId);
    expect(adapter.shopExternalId).toBe("987654");
    expect(adapter.user).toBeNull();
  });
});
