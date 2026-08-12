/**
 * eBay token-lifecycle tests (loxep-62y.2): the `ebay.refresh-tokens` task and
 * the adapter factory's refresh-and-PERSIST path, against a real scratch
 * database with the provider OAuth exchange mocked (no network).
 *
 * What is proved end to end:
 *  - the keyset resolves from the application secret `integration.ebay.keyset`;
 *  - an access token inside the refresh skew window is refreshed;
 *  - the refreshed bundle is written back as a NEW `connection_credentials`
 *    version through the connection-credentials service, with `expires_at` /
 *    `refresh_after` from `credentialWriteForBundle`;
 *  - the non-secret half (scopes, refresh-token expiry) lives on
 *    `connections.config.ebayOAuth`, never in the ciphertext;
 *  - the dispatch mode enqueues exactly one job per eBay connection that has
 *    a stored token, with a per-connection job key.
 *
 * Every credential value here is fake, and the leak check is a programmatic
 * containment comparison.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { jobKeyFor } from "@loxep/jobs";
import type { TaskContext } from "@loxep/jobs";
import {
  EBAY_BASE_SCOPE,
  EbayAdapterError,
} from "@loxep/integration-ebay";
import type {
  EbayAdapter,
  EbayUserAdapter,
  EbayUserTokenBundle,
} from "@loxep/integration-ebay";
import {
  EBAY_CONNECTION_CONFIG_KEY,
  EBAY_KEYSET_SECRET_KEY,
  EBAY_OAUTH_CREDENTIAL_TYPE,
  REFRESH_TOKENS_TASK_NAME,
  buildAppServices,
  createEbayAdapterFactory,
  createEbayTokenRefreshTasks,
} from "../src/index.ts";
import type { AppServices, EbayAdapterConstructor } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

// FAKE values only.
const FAKE_KEYSET = {
  appId: "FakeApp-fakefake-SBX-0123456789ab-cdef0123",
  certId: "SBX-fakefakefake-abcd-1234-5678-9abc",
  devId: "01234567-89ab-cdef-0123-456789abcdef",
  ruName: "Fake_Loxep-FakeApp-fakefa-abcdefghi",
  environment: "sandbox",
} as const;
const STALE_ACCESS_TOKEN = "FAKE-ebay-access-stale-9c41";
const FRESH_ACCESS_TOKEN = "FAKE-ebay-access-fresh-1b77";
const FAKE_REFRESH_TOKEN = "FAKE-ebay-refresh-2f8d";

const dbName = scratchDbName("loxep_test_app_refresh");
let databaseUrl = "";
let handle: DbHandle;
let services: AppServices;
let connectionId = "";

/** Records what the stubbed provider exchange was asked to do. */
const refreshCalls: Array<{ refreshToken: string; scopes: string[] }> = [];

/**
 * A provider client whose OAuth exchange is stubbed at exactly the seam
 * `refreshTokenBundleIfNeeded` uses: it calls
 * `adapter.withUserToken(placeholder).refreshUserToken()`.
 */
const stubbedAdapter: EbayAdapterConstructor = () => {
  const adapter = {
    environment: "sandbox" as const,
    marketplaceId: "EBAY_US",
    withUserToken: (bundle: EbayUserTokenBundle) => {
      let current = bundle;
      const userAdapter = {
        environment: "sandbox" as const,
        marketplaceId: "EBAY_US",
        currentTokenBundle: () => current,
        refreshUserToken: async () => {
          refreshCalls.push({
            refreshToken: current.refreshToken,
            scopes: [...current.scopes],
          });
          if (current.refreshToken !== FAKE_REFRESH_TOKEN) {
            throw new EbayAdapterError("auth", "unknown fake refresh token");
          }
          current = {
            ...current,
            accessToken: FRESH_ACCESS_TOKEN,
            accessTokenExpiresAt: new Date(
              Date.now() + 7200 * 1000,
            ).toISOString(),
          };
          return current;
        },
      } as unknown as EbayUserAdapter;
      return userAdapter;
    },
  } as unknown as EbayAdapter;
  return adapter;
};

/** Graphile helpers stub: only `addJob` is reachable from this task. */
function helpersWithAddJob(
  calls: Array<{ identifier: string; payload: unknown; spec: unknown }>,
): TaskContext["helpers"] {
  return {
    addJob: async (identifier: string, payload: unknown, spec: unknown) => {
      calls.push({ identifier, payload, spec });
      return {} as never;
    },
  } as unknown as TaskContext["helpers"];
}

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  const config = testConfig(databaseUrl);

  const base = buildAppServices({ config, logger: silentJobsLogger });
  // Same service graph, but with the provider-client seam stubbed.
  const factory = createEbayAdapterFactory({
    db: base.db,
    secrets: base.secrets,
    connections: base.connections,
    connectionCredentials: base.connectionCredentials,
    logger: silentJobsLogger,
    createAdapter: stubbedAdapter,
  });
  services = {
    ...base,
    getEbayAdapterForConnection: factory.getAdapterForConnection,
    invalidateEbayAdapter: factory.invalidate,
    ebayIntervalFloorSeconds: factory.intervalFloorSeconds,
  };

  await handle.db.insert(user).values({
    id: "test-user",
    name: "Test User",
    email: "refresh@example.invalid",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await services.secrets.setSecret({
    secretKey: EBAY_KEYSET_SECRET_KEY,
    purpose: "ebay_keyset",
    payload: { ...FAKE_KEYSET },
  });

  const connection = await services.connections.createConnection({
    provider: "ebay",
    kind: "marketplace",
    name: "sandbox buyer",
    createdByUserId: "test-user",
    config: {
      [EBAY_CONNECTION_CONFIG_KEY]: {
        environment: "sandbox",
        scopes: [EBAY_BASE_SCOPE],
        refreshTokenExpiresAt: new Date(
          Date.now() + 400 * 24 * 3600 * 1000,
        ).toISOString(),
      },
    },
  });
  connectionId = connection.id;

  // A stored token already inside the 5-minute refresh skew window.
  await services.connectionCredentials.setCredential({
    connectionId,
    credentialType: EBAY_OAUTH_CREDENTIAL_TYPE,
    payload: {
      accessToken: STALE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
    },
    expiresAt: new Date(Date.now() + 60 * 1000),
    refreshAfter: new Date(Date.now() - 240 * 1000),
  });
}, 120_000);

afterAll(async () => {
  await services?.close();
  await closeDb(handle);
  await dropScratchDb(dbName);
});

describe("ebay.refresh-tokens", () => {
  it("refreshes an expiring token and persists the new bundle", async () => {
    const before = (
      await services.connectionCredentials.listCredentials(connectionId)
    )[0];
    expect(before?.currentVersion).toBe(1);

    const tasks = createEbayTokenRefreshTasks({ services });
    expect(tasks.refreshTokensTask.name).toBe(REFRESH_TOKENS_TASK_NAME);
    expect(tasks.refreshTokensCronItem.match).toBe("*/15 * * * *");

    await tasks.refreshTokensTask.handler(
      { connectionId },
      { logger: silentJobsLogger, helpers: helpersWithAddJob([]) },
    );

    // The provider exchange ran with the STORED refresh token and scopes.
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.refreshToken).toBe(FAKE_REFRESH_TOKEN);
    expect(refreshCalls[0]?.scopes).toEqual([EBAY_BASE_SCOPE]);

    // A NEW immutable credential version now holds the refreshed token.
    const after = (
      await services.connectionCredentials.listCredentials(connectionId)
    )[0];
    expect(after?.currentVersion).toBe(2);
    expect(after?.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3600_000);
    // refresh_after = expiry − skew (300s), per credentialWriteForBundle.
    expect(after!.refreshAfter!.getTime()).toBe(
      after!.expiresAt!.getTime() - 300_000,
    );

    const payload = await services.connectionCredentials.getCredentialPayload(
      connectionId,
      EBAY_OAUTH_CREDENTIAL_TYPE,
    );
    expect(payload.payload.accessToken).toBe(FRESH_ACCESS_TOKEN);
    expect(payload.payload.refreshToken).toBe(FAKE_REFRESH_TOKEN);

    // The connection is healthy and its non-secret consent facts survived.
    const connection = await services.connections.getConnection(connectionId);
    expect(connection.status).toBe("active");
    expect(connection.lastSuccessAt).not.toBeNull();
    const oauth = connection.config[EBAY_CONNECTION_CONFIG_KEY] as Record<
      string,
      unknown
    >;
    expect(oauth["scopes"]).toEqual([EBAY_BASE_SCOPE]);
    expect(oauth["environment"]).toBe("sandbox");

    // No token material in plaintext columns.
    const versions = await handle.pool.query<{ ciphertext: Buffer }>(
      "select ciphertext from connection_credential_versions",
    );
    for (const row of versions.rows) {
      expect(row.ciphertext.toString("utf8")).not.toContain(FRESH_ACCESS_TOKEN);
    }
    const connectionRow = await handle.pool.query<{ config: unknown }>(
      "select config from connections",
    );
    expect(JSON.stringify(connectionRow.rows)).not.toContain(
      FRESH_ACCESS_TOKEN,
    );
  });

  it("is a no-op for a token that is still comfortably valid", async () => {
    const callsBefore = refreshCalls.length;
    const tasks = createEbayTokenRefreshTasks({ services });
    await tasks.refreshTokensTask.handler(
      { connectionId },
      { logger: silentJobsLogger, helpers: helpersWithAddJob([]) },
    );
    // The stored token is now ~2h out; nothing to exchange.
    expect(refreshCalls).toHaveLength(callsBefore);
    const after = (
      await services.connectionCredentials.listCredentials(connectionId)
    )[0];
    expect(after?.currentVersion).toBe(2);
  });

  it("dispatches one keyed job per eBay connection that has a token", async () => {
    // A second eBay connection WITHOUT a credential must not be enqueued.
    await services.connections.createConnection({
      provider: "ebay",
      kind: "marketplace",
      name: "not yet consented",
      createdByUserId: "test-user",
    });
    // A non-eBay connection must not be enqueued either.
    await services.connections.createConnection({
      provider: "woocommerce",
      kind: "store",
      name: "some shop",
      createdByUserId: "test-user",
    });

    const calls: Array<{
      identifier: string;
      payload: unknown;
      spec: unknown;
    }> = [];
    const tasks = createEbayTokenRefreshTasks({ services });
    await tasks.refreshTokensTask.handler(
      {},
      { logger: silentJobsLogger, helpers: helpersWithAddJob(calls) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.identifier).toBe(REFRESH_TOKENS_TASK_NAME);
    expect(calls[0]?.payload).toEqual({ connectionId });
    expect(calls[0]?.spec).toMatchObject({
      jobKey: jobKeyFor(REFRESH_TOKENS_TASK_NAME, connectionId),
      jobKeyMode: "replace",
    });
  });

  it("skips an archived connection even though it still holds a token", async () => {
    // Archiving is terminal retirement (loxep-o7h): the credential rows are
    // deliberately KEPT, so only the status gate stops the refresh.
    await services.connections.archiveConnection(connectionId);
    try {
      const calls: Array<{
        identifier: string;
        payload: unknown;
        spec: unknown;
      }> = [];
      const tasks = createEbayTokenRefreshTasks({ services });
      await tasks.refreshTokensTask.handler(
        {},
        { logger: silentJobsLogger, helpers: helpersWithAddJob(calls) },
      );
      expect(calls).toHaveLength(0);
    } finally {
      await services.connections.unarchiveConnection(connectionId);
    }
  });
});
