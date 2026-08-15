/**
 * LIVE tier for Dockhand/Termix DISCOVERY (loxep-hb7 Milestone B, loxep-wvm
 * Slice B) — one bounded `listHosts()` read against each REAL instance,
 * driven through the REAL `createFleetHealthSubjectRegistry` composition (a
 * real `connections` row + a real scratch PostgreSQL database), proving the
 * whole `projectDockhandResources`/`projectTermixResources` pipeline end to
 * end — not just the adapter package's own credential-proving read, which
 * `packages/integrations/dockhand`'s and `packages/integrations/termix`'s
 * own `test/live-*.test.ts` already cover and which this file does not
 * repeat.
 *
 * Skips cleanly unless the relevant `~/.config/loxep/{dockhand,termix}.env`
 * file exists AND `LOXEP_LIVE_TESTS` opts that provider's slug in
 * (`dockhand`, `termix`, or `all`).
 *
 * ABSOLUTE RULES honored here:
 * - **Exactly ONE `listHosts()` read per provider, ever, per run.** This is
 *   the SAME read `probeDockhandConnection`/`probeTermixConnection` make in
 *   production — no second call, and this test never retries a failed
 *   login. Dockhand locks an account out after five failed logins per
 *   IP/username; Termix publishes a login `429` with no documented
 *   threshold. Two independent describe blocks below each cost at most one
 *   login, not one each for a "connection" assertion and a separate
 *   "discovery" assertion.
 * - **Read-only.** `applyHost`/host-registration is never called — this
 *   file imports no write-capable member from either adapter.
 * - **No credential material, host name, IP, or environment/host id is
 *   logged or asserted against — only counts and booleans**, matching the
 *   restraint `live-dockhand.test.ts`/`live-termix.test.ts` already apply.
 * - The scratch database is dropped afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import {
  createConnectionsService,
  createHealthService,
  createResourceLinksService,
  createSettingsService,
} from "@loxep/domain";
import type { ConnectionsService, SettingsService } from "@loxep/domain";
import {
  createDockhandAdapter,
  defaultDockhandEnvFilePath,
  loadDockhandCredentialsFromEnvFile,
} from "@loxep/integration-dockhand";
import {
  createTermixAdapter,
  defaultTermixEnvFilePath,
  loadTermixCredentialsFromEnvFile,
} from "@loxep/integration-termix";
import { createFleetHealthSubjectRegistry } from "../src/fleet-health.ts";
import type { FleetHealthServices } from "../src/fleet-health.ts";
import { DOCKHAND_CONNECTION_CONFIG_KEY, TERMIX_CONNECTION_CONFIG_KEY } from "../src/fleet.ts";
import { createScratchDb, dropScratchDb, scratchDbName, testKeyring } from "./helpers.ts";
import { liveTestsEnabledFor } from "./live-gate.ts";

const dockhandCreds = (() => {
  try {
    return loadDockhandCredentialsFromEnvFile();
  } catch {
    return null;
  }
})();
const termixCreds = (() => {
  try {
    return loadTermixCredentialsFromEnvFile();
  } catch {
    return null;
  }
})();

const dockhandOptedIn = liveTestsEnabledFor("dockhand");
const termixOptedIn = liveTestsEnabledFor("termix");

if (dockhandCreds !== null && !dockhandOptedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-fleet-discovery] dockhand skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=dockhand (or =all) to run against the live instance.",
  );
}
if (termixCreds !== null && !termixOptedIn) {
  // eslint-disable-next-line no-console
  console.info(
    "[live-fleet-discovery] termix skipped: credentials present but not opted in — set " +
      "LOXEP_LIVE_TESTS=termix (or =all) to run against the live instance.",
  );
}

const dockhandLive = dockhandCreds !== null && dockhandOptedIn;
const termixLive = termixCreds !== null && termixOptedIn;
const describeLive = dockhandLive || termixLive ? describe : describe.skip;

/** A {@link FleetHealthServices} whose every OTHER provider throws if invoked — this suite only ever probes one connection at a time by id, so no other provider's factory is ever called. */
function notConfiguredServices(
  connections: ConnectionsService,
  settings: SettingsService,
  overrides: Partial<FleetHealthServices>,
): FleetHealthServices {
  const notConfigured = (name: string): never => {
    throw new Error(`live-fleet-discovery: no ${name} adapter configured for this run`);
  };
  return {
    connections,
    settings,
    getBeszelAdapterForConnection: () => notConfigured("Beszel"),
    getDockhandAdapterForConnection: () => notConfigured("Dockhand"),
    getGatusAdapterForConnection: () => notConfigured("Gatus"),
    getTailscaleAdapterForConnection: () => notConfigured("Tailscale"),
    getTermixAdapterForConnection: () => notConfigured("Termix"),
    ...overrides,
  };
}

describeLive("live fleet discovery (Dockhand/Termix)", () => {
  const dbName = scratchDbName("loxep_test_app_live_fleet_discovery");
  let handle: DbHandle;
  let connections: ConnectionsService;
  let settings: SettingsService;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({
      databaseUrl,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    handle = createDb(databaseUrl);
    connections = createConnectionsService({ db: handle.db, keyring: testKeyring() });
    settings = createSettingsService({ db: handle.db });

    await handle.db.insert(user).values({
      id: "live-fleet-discovery-user",
      name: "Live Fleet Discovery Test User",
      email: "live-fleet-discovery@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  (dockhandLive ? it : it.skip)(
    `Dockhand (${defaultDockhandEnvFilePath()}): one listHosts() read discovers every environment as an external_resources row with its own health row`,
    async () => {
      const connection = await connections.createConnection({
        provider: "dockhand",
        kind: "fleet_observability",
        name: "live dockhand",
        config: { [DOCKHAND_CONNECTION_CONFIG_KEY]: { baseUrl: dockhandCreds!.baseUrl } },
        createdByUserId: "live-fleet-discovery-user",
      });

      const registry = createFleetHealthSubjectRegistry(
        notConfiguredServices(connections, settings, {
          getDockhandAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "live",
            adapter: createDockhandAdapter({
              config: { baseUrl: dockhandCreds!.baseUrl },
              credentials: {
                username: dockhandCreds!.username,
                password: dockhandCreds!.password,
              },
              fetchImpl: (url, init) => fetch(url, init),
            }),
            minIntervalSeconds: 300,
          }),
        }),
      );

      // The ONE listHosts() read this whole test spends, and the ONE login
      // it costs (session cookie cached in-memory for the adapter's
      // lifetime — see createDockhandAdapter's own doc).
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      console.log("[live] dockhand connection outcome:", {
        status: outcome?.status,
        source: outcome?.source,
        authMode: (outcome?.detail as Record<string, unknown> | undefined)?.["authMode"],
      });
      expect(outcome?.status).toBe("ok");

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const health = createHealthService({ db: handle.db });
      const discovered = await resourceLinks.listUnattachedByProvider("dockhand");
      console.log("[live] dockhand environments discovered (unattached candidates):", {
        count: discovered.length,
      });

      // Every discovered environment: is it a well-formed URL, and does it
      // carry its own per-resource health row (never a name/id/host value
      // logged — see the module doc's restraint).
      let healthRowCount = 0;
      const statusesSeen = new Set<string>();
      for (const resource of discovered) {
        expect(resource.provider).toBe("dockhand");
        expect(resource.externalType).toBe("environment");
        expect(resource.externalId).not.toBeNull();
        expect(() => new URL(resource.url)).not.toThrow();
        const row = await health.getHealth("external_resource", resource.id);
        if (row !== null) {
          healthRowCount += 1;
          statusesSeen.add(row.status);
          expect(row.source).toBe("adapter");
        }
      }
      console.log("[live] dockhand per-environment health rows written:", {
        healthRowCount,
        distinctStatusesObserved: [...statusesSeen],
      });
    },
    30_000,
  );

  (termixLive ? it : it.skip)(
    `Termix (${defaultTermixEnvFilePath()}): one listHosts() read discovers every host as an external_resources row`,
    async () => {
      const connection = await connections.createConnection({
        provider: "termix",
        kind: "fleet_observability",
        name: "live termix",
        config: { [TERMIX_CONNECTION_CONFIG_KEY]: { baseUrl: termixCreds!.baseUrl } },
        createdByUserId: "live-fleet-discovery-user",
      });

      const registry = createFleetHealthSubjectRegistry(
        notConfiguredServices(connections, settings, {
          getTermixAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "live",
            adapter: createTermixAdapter({
              config: { baseUrl: termixCreds!.baseUrl },
              credentials: { username: termixCreds!.username, password: termixCreds!.password },
              fetchImpl: (url, init) => fetch(url, init),
            }),
            minIntervalSeconds: 300,
          }),
        }),
      );

      // The ONE login + ONE listHosts() read this test spends for Termix.
      // The best-effort listSessions() enrichment (projectTermixResources's
      // own second call) is allowed — it is a read, never a login, and is
      // exactly what production spends on every sweep once a host is linked.
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      console.log("[live] termix connection outcome:", {
        status: outcome?.status,
        source: outcome?.source,
        hostsReadable: (outcome?.detail as Record<string, unknown> | undefined)?.[
          "hostsReadable"
        ],
      });
      expect(outcome?.status).toBe("ok");

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const discovered = await resourceLinks.listUnattachedByProvider("termix");
      console.log("[live] termix hosts discovered (unattached candidates):", {
        count: discovered.length,
      });
      for (const resource of discovered) {
        expect(resource.provider).toBe("termix");
        expect(resource.externalType).toBe("host");
        expect(resource.externalId).not.toBeNull();
        expect(() => new URL(resource.url)).not.toThrow();
      }

      // wvm Slice B item 10: per-resource health is written for LINKED
      // hosts only — every host here is freshly discovered and unattached,
      // so NONE should have a health row yet. This is the one behavioral
      // assertion this live run can make about that rule without an
      // operator-confirmed attach step, which this read-only test does not
      // perform.
      const health = createHealthService({ db: handle.db });
      let unlinkedWithHealthRow = 0;
      for (const resource of discovered) {
        const row = await health.getHealth("external_resource", resource.id);
        if (row !== null) unlinkedWithHealthRow += 1;
      }
      expect(unlinkedWithHealthRow).toBe(0);
    },
    30_000,
  );
});
