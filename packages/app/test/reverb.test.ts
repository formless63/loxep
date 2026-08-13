/**
 * `createReverbAdapterFactory` (loxep-g4t.3): the ONE property that matters
 * most here is the PER-CONNECTION rate budget/adapter — the load-bearing
 * divergence from `createEtsyAdapterFactory`'s shared-per-application shape
 * (see `reverb.ts`'s module doc). Structurally this mirrors
 * `createWooAdapterFactory`/`createPurelymailAdapterFactory` far more than
 * it mirrors Etsy's factory.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import {
  createConnectionCredentialsService,
  createConnectionsService,
} from "@loxep/domain";
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import { ReverbCredentialsMissingError, createReverbAdapterFactory } from "../src/index.ts";
import type { ReverbAdapter } from "../../integrations/reverb/src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, testKeyring } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_app_reverb");
let handle: DbHandle;
let connections: ConnectionsService;
let connectionCredentials: ConnectionCredentialsService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: { info: () => {}, warn: () => {}, error: () => {} } });
  handle = createDb(databaseUrl);
  const keyring = testKeyring();
  connections = createConnectionsService({ db: handle.db, keyring });
  connectionCredentials = createConnectionCredentialsService({ db: handle.db, keyring });

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "reverb-factory@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

async function createReverbConnection(label: string): Promise<string> {
  const connection = await connections.createConnection({
    provider: "reverb",
    kind: "marketplace_account",
    name: `reverb account ${label}`,
    createdByUserId: "test-user",
  });
  await connections.setConnectionCredential(
    connection.id,
    "reverb_credentials",
    { personalAccessToken: `fake-pat-${label}` },
    { actorUserId: "test-user" },
  );
  return connection.id;
}

describe("createReverbAdapterFactory — per-connection budget/adapter", () => {
  it("builds a SEPARATE ReverbAdapter for two different connections", async () => {
    let constructions = 0;
    const factory = createReverbAdapterFactory({
      connections,
      connectionCredentials,
      createAdapter: () => {
        constructions += 1;
        return {} as ReverbAdapter;
      },
    });

    const connectionA = await createReverbConnection("a");
    const connectionB = await createReverbConnection("b");

    const adapterA = await factory.getAdapterForConnection(connectionA);
    const adapterB = await factory.getAdapterForConnection(connectionB);

    // TWO separate constructions — the entire point, unlike Etsy's ONE.
    expect(constructions).toBe(2);
    expect(adapterA.adapter).not.toBe(adapterB.adapter);
    expect(adapterA.sourceAccountKey).toBe(`reverb:${connectionA}`);
    expect(adapterB.sourceAccountKey).toBe(`reverb:${connectionB}`);
  });

  it("does not rebuild the adapter on repeated lookups of the same connection", async () => {
    let constructions = 0;
    const factory = createReverbAdapterFactory({
      connections,
      connectionCredentials,
      createAdapter: () => {
        constructions += 1;
        return {} as ReverbAdapter;
      },
    });
    const connectionId = await createReverbConnection("c");
    await factory.getAdapterForConnection(connectionId);
    await factory.getAdapterForConnection(connectionId);
    await factory.getAdapterForConnection(connectionId);
    expect(constructions).toBe(1);
  });

  it("invalidate() forces a rebuild on the next lookup", async () => {
    let constructions = 0;
    const factory = createReverbAdapterFactory({
      connections,
      connectionCredentials,
      createAdapter: () => {
        constructions += 1;
        return {} as ReverbAdapter;
      },
    });
    const connectionId = await createReverbConnection("d");
    await factory.getAdapterForConnection(connectionId);
    factory.invalidate(connectionId);
    await factory.getAdapterForConnection(connectionId);
    expect(constructions).toBe(2);
  });
});

describe("createReverbAdapterFactory — credential resolution", () => {
  it("throws ReverbCredentialsMissingError when no credential is stored", async () => {
    const factory = createReverbAdapterFactory({
      connections,
      connectionCredentials,
      createAdapter: () => ({}) as ReverbAdapter,
    });
    const connection = await connections.createConnection({
      provider: "reverb",
      kind: "marketplace_account",
      name: "no credential yet",
      createdByUserId: "test-user",
    });
    await expect(
      factory.getAdapterForConnection(connection.id),
    ).rejects.toThrowError(ReverbCredentialsMissingError);
  });

  it("throws when the connection's provider is not 'reverb'", async () => {
    const factory = createReverbAdapterFactory({
      connections,
      connectionCredentials,
      createAdapter: () => ({}) as ReverbAdapter,
    });
    const connection = await connections.createConnection({
      provider: "ebay",
      kind: "marketplace_account",
      name: "wrong provider",
      createdByUserId: "test-user",
    });
    await expect(
      factory.getAdapterForConnection(connection.id),
    ).rejects.toThrowError(ReverbCredentialsMissingError);
  });
});
