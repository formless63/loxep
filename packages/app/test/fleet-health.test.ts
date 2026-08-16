/**
 * `createFleetHealthSubjectRegistry` (loxep-rf4 shared slice): the
 * provider-specific status mappings for Beszel/Dockhand/Gatus/Tailscale/
 * Termix, the connections-bookkeeping rule, the Gatus heartbeat mirror and
 * its BINDING RULE 1, and the non-fleet fallback.
 *
 * Every fleet adapter is a FAKE injected through {@link FleetHealthServices}
 * directly — this suite is about the MAPPING logic in `fleet-health.ts`, not
 * about `fleet.ts`'s real adapter-factory wiring (covered by `fleet.test.ts`)
 * or live provider behavior (covered by each integration package's own
 * gated `test/live-*.test.ts`). PostgreSQL, `@loxep/domain`'s connections/
 * settings/health services, and the composed registry itself are all real.
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
  gatusPushFactKeys,
  gatusPushSetting,
  runHealthSweep,
} from "@loxep/domain";
import type { Connection, ConnectionsService, SettingsService } from "@loxep/domain";
import { BeszelAdapterError } from "@loxep/integration-beszel";
import type { BeszelAdapter } from "@loxep/integration-beszel";
import { DockhandAdapterError } from "@loxep/integration-dockhand";
import type { DockhandAdapter } from "@loxep/integration-dockhand";
import { GatusAdapterError, normalizeGatusBaseUrl } from "@loxep/integration-gatus";
import type { GatusAdapter } from "@loxep/integration-gatus";
import { TailscaleAdapterError } from "@loxep/integration-tailscale";
import type { TailscaleAdapter } from "@loxep/integration-tailscale";
import { TermixAdapterError } from "@loxep/integration-termix";
import type { TermixAdapter } from "@loxep/integration-termix";
import { PangolinAdapterError } from "@loxep/integration-pangolin";
import {
  createHostAddressesService,
  createHostingTargetsService,
} from "@loxep/infrastructure";
import { createFleetHealthSubjectRegistry } from "../src/fleet-health.ts";
import type { FleetHealthServices } from "../src/fleet-health.ts";
import { BeszelCredentialsMissingError } from "../src/fleet.ts";
import { PangolinCredentialsMissingError } from "../src/pangolin.ts";
import { createScratchDb, dropScratchDb, scratchDbName, testKeyring } from "./helpers.ts";

describe("createFleetHealthSubjectRegistry", () => {
  const dbName = scratchDbName("loxep_test_app_fleet_health");
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
      id: "fleet-health-test-user",
      name: "Fleet Health Test User",
      email: "fleet-health@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  async function createFleetConnection(
    provider: string,
    label: string,
    config: Record<string, unknown> = {},
  ): Promise<Connection> {
    return connections.createConnection({
      provider,
      kind: "fleet_observability",
      name: `${provider} ${label}`,
      config,
      createdByUserId: "fleet-health-test-user",
    });
  }

  /** A {@link FleetHealthServices} whose adapter factories are all overridable fakes. */
  function fakeServices(
    overrides: Partial<FleetHealthServices> = {},
  ): FleetHealthServices {
    const notConfigured = (name: string): never => {
      throw new Error(`fleet-health test: no fake ${name} adapter was configured`);
    };
    return {
      connections,
      settings,
      getBeszelAdapterForConnection: () => notConfigured("Beszel"),
      getDockhandAdapterForConnection: () => notConfigured("Dockhand"),
      getCloudflareAdapterForConnection: () => notConfigured("Cloudflare"),
      getPurelymailAdapterForConnection: () => notConfigured("Purelymail"),
      getGatusAdapterForConnection: () => notConfigured("Gatus"),
      getTailscaleAdapterForConnection: () => notConfigured("Tailscale"),
      getTermixAdapterForConnection: () => notConfigured("Termix"),
      getPangolinAdapterForConnection: () => notConfigured("Pangolin"),
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Beszel
  // ---------------------------------------------------------------------------

  describe("beszel", () => {
    it("health() failing at all -> unknown, never failing", async () => {
      const connection = await createFleetConnection("beszel", "unreachable");
      const adapter = {
        health: async () => {
          throw new Error("network error");
        },
        listSystems: async () => {
          throw new Error("must not be called when health() fails");
        },
      } as unknown as BeszelAdapter;
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getBeszelAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "beszel:test",
            adapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
      expect(outcome?.source).toBe("adapter");
    });

    it("health() ok, listSystems() auth error -> failing, kind auth", async () => {
      const connection = await createFleetConnection("beszel", "bad-credential");
      const adapter = {
        health: async () => ({ reachable: true, httpStatus: 200, message: null }),
        listSystems: async (options?: { filter?: string }) => {
          expect(options?.filter).toBeUndefined();
          throw new BeszelAdapterError("auth", "rejected", { httpStatus: 401 });
        },
      } as unknown as BeszelAdapter;
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getBeszelAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "beszel:test",
            adapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth" });
    });

    it("health() ok, listSystems() other error -> failing, that kind", async () => {
      const connection = await createFleetConnection("beszel", "hub-misbehaving");
      const adapter = {
        health: async () => ({ reachable: true, httpStatus: 200, message: null }),
        listSystems: async () => {
          throw new BeszelAdapterError("provider_unavailable", "5xx");
        },
      } as unknown as BeszelAdapter;
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getBeszelAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "beszel:test",
            adapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "provider_unavailable" });
    });

    it("both ok -> ok, with counts only and no filter", async () => {
      const connection = await createFleetConnection("beszel", "healthy");
      const adapter = {
        health: async () => ({ reachable: true, httpStatus: 200, message: null }),
        listSystems: async (options?: { filter?: string }) => {
          expect(options?.filter).toBeUndefined();
          return [
            { externalSystemId: "1", status: "up" },
            { externalSystemId: "2", status: "up" },
            { externalSystemId: "3", status: "down" },
          ];
        },
      } as unknown as BeszelAdapter;
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getBeszelAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "beszel:test",
            adapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.source).toBe("adapter");
      expect(outcome?.detail).toEqual({
        systems: 3,
        up: 2,
        notUp: 1,
        hubReachable: true,
      });
    });

    it("a misconfigured connection (no stored credential) -> unknown, kind misconfigured", async () => {
      const connection = await createFleetConnection("beszel", "misconfigured");
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getBeszelAdapterForConnection: async () => {
            throw new BeszelCredentialsMissingError("no credential stored");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "misconfigured" });
    });
  });

  // ---------------------------------------------------------------------------
  // Beszel discovery + per-system health projection (loxep-y64 slice 3)
  // ---------------------------------------------------------------------------

  describe("beszel discovery + per-system health projection", () => {
    const BESZEL_BASE_URL = "https://beszel-discovery.example.test";

    function beszelDiscoveryConnection(label: string): Promise<Connection> {
      return createFleetConnection("beszel", label, { beszel: { baseUrl: BESZEL_BASE_URL } });
    }

    function discoveryAdapter(systems: Record<string, unknown>[]) {
      return {
        health: async () => ({ reachable: true, httpStatus: 200, message: null }),
        listSystems: async () => systems,
      } as unknown as BeszelAdapter;
    }

    function discoveryServices(systems: Record<string, unknown>[]) {
      return fakeServices({
        getBeszelAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "beszel:test",
          adapter: discoveryAdapter(systems),
          minIntervalSeconds: 300,
        }),
      });
    }

    it("upserts one external_resources row per system, and two sweeps collapse to one row (loxep-uhs idempotency)", async () => {
      const connection = await beszelDiscoveryConnection("discovery-idempotent");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          { externalSystemId: "sys-idempotent-1", name: "web-1", status: "up" },
        ]),
      );

      await registry.connection?.probe(handle.db, connection.id);
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const matches = (await resourceLinks.listUnattachedByProvider("beszel")).filter(
        (row) => row.externalId === "sys-idempotent-1",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.title).toBe("web-1");
      expect(matches[0]?.url).toBe(`${BESZEL_BASE_URL}/system/sys-idempotent-1`);
      expect(matches[0]?.connectionId).toBe(connection.id);
    });

    it("writes a per-system integration_health row keyed subject_type='external_resource', source='adapter', never 'hosting_target'", async () => {
      const connection = await beszelDiscoveryConnection("discovery-health-row");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          {
            externalSystemId: "sys-health-row",
            name: "db-1",
            host: "10.0.0.5",
            port: 45876,
            status: "up",
            observedAt: "2026-08-14T12:00:00.000Z",
            sharedWithCount: 0,
          },
        ]),
      );

      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("beszel")).find(
        (row) => row.externalId === "sys-health-row",
      );
      expect(resource).toBeDefined();
      expect(resource?.metadata).toEqual({
        status: "up",
        observedAt: "2026-08-14T12:00:00.000Z",
        host: "10.0.0.5",
        port: 45876,
        sharedWithCount: 0,
      });

      const health = createHealthService({ db: handle.db });
      const healthRow = await health.getHealth("external_resource", resource!.id);
      expect(healthRow?.status).toBe("ok");
      expect(healthRow?.source).toBe("adapter");
      expect(healthRow?.detail).toEqual({
        status: "up",
        observedAt: "2026-08-14T12:00:00.000Z",
      });

      // Never a hosting_target row for this system — the shared-row race
      // named across every sibling design (loxep-y64 §1, loxep-uhs).
      const hostingTargetRows = await health.listHealth({ subjectType: "hosting_target" });
      expect(hostingTargetRows.some((row) => row.subjectId === resource!.id)).toBe(false);
    });

    it.each([
      ["up", "ok"],
      ["down", "failing"],
      ["paused", "unknown"],
      ["some-future-status", "unknown"],
      ["", "unknown"],
    ] as const)(
      "maps beszel status %s -> integration_health status %s",
      async (beszelStatus, expectedHealthStatus) => {
        const label = beszelStatus === "" ? "empty" : beszelStatus;
        const connection = await beszelDiscoveryConnection(`discovery-status-${label}`);
        const externalSystemId = `sys-status-${label}`;
        const registry = createFleetHealthSubjectRegistry(
          discoveryServices([{ externalSystemId, status: beszelStatus }]),
        );
        await registry.connection?.probe(handle.db, connection.id);

        const resourceLinks = createResourceLinksService({ db: handle.db });
        const resource = (await resourceLinks.listUnattachedByProvider("beszel")).find(
          (row) => row.externalId === externalSystemId,
        );
        expect(resource).toBeDefined();
        const health = createHealthService({ db: handle.db });
        const healthRow = await health.getHealth("external_resource", resource!.id);
        expect(healthRow?.status).toBe(expectedHealthStatus);
        expect(healthRow?.detail["status"]).toBe(beszelStatus);
      },
    );

    it("keeps a discovered-but-unlinked system rather than deleting it — the attach picker's candidate list", async () => {
      const connection = await beszelDiscoveryConnection("discovery-kept-unlinked");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([{ externalSystemId: "sys-kept", status: "up" }]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const stillThere = (await resourceLinks.listUnattachedByProvider("beszel")).find(
        (row) => row.externalId === "sys-kept",
      );
      expect(stillThere).toBeDefined();
    });

    it("a connection with no stored base URL discovers nothing but still reports its own status normally", async () => {
      // No `beszel.baseUrl` in config — createFleetConnection's own default.
      const connection = await createFleetConnection("beszel", "discovery-no-base-url");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([{ externalSystemId: "sys-no-base-url", status: "up" }]),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const found = (await resourceLinks.listUnattachedByProvider("beszel")).find(
        (row) => row.externalId === "sys-no-base-url",
      );
      expect(found).toBeUndefined();
    });

    it("the generic tier-2 credential-free probe never lists a discovered beszel resource as a candidate", async () => {
      const connection = await beszelDiscoveryConnection("discovery-no-tier2-race");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([{ externalSystemId: "sys-no-tier2-race", status: "up" }]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("beszel")).find(
        (row) => row.externalId === "sys-no-tier2-race",
      );
      expect(resource).toBeDefined();

      const candidates = await registry.external_resource?.listCandidates(handle.db);
      expect(candidates?.map((candidate) => candidate.subjectId)).not.toContain(resource!.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Dockhand
  // ---------------------------------------------------------------------------

  describe("dockhand", () => {
    function makeDockhandServices(
      adapter: Partial<DockhandAdapter>,
    ): FleetHealthServices {
      return fakeServices({
        getDockhandAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "dockhand:test",
          adapter: adapter as DockhandAdapter,
          minIntervalSeconds: 300,
        }),
      });
    }

    it("network error on probeSession() -> unknown, never failing", async () => {
      const connection = await createFleetConnection("dockhand", "unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makeDockhandServices({
          probeSession: async () => {
            throw new DockhandAdapterError("provider_unavailable", "network error", {
              errorName: "TypeError",
            });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("HTTP responded, kind auth on probeSession() -> failing, kind auth", async () => {
      const connection = await createFleetConnection("dockhand", "bad-credential");
      const registry = createFleetHealthSubjectRegistry(
        makeDockhandServices({
          probeSession: async () => {
            throw new DockhandAdapterError("auth", "rejected", { httpStatus: 403 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth" });
    });

    it("HTTP responded, any other kind on probeSession() -> failing, that kind", async () => {
      const connection = await createFleetConnection("dockhand", "rate-limited");
      const registry = createFleetHealthSubjectRegistry(
        makeDockhandServices({
          probeSession: async () => {
            throw new DockhandAdapterError("rate_limited", "429", { httpStatus: 429 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "rate_limited" });
    });

    it("session ok, authenticationEnabled false -> ok, authMode disabled (listHosts never called)", async () => {
      const connection = await createFleetConnection("dockhand", "auth-disabled");
      let listHostsCalled = false;
      const registry = createFleetHealthSubjectRegistry(
        makeDockhandServices({
          probeSession: async () => ({
            authenticationEnabled: false,
            authenticated: false,
          }),
          listHosts: async () => {
            listHostsCalled = true;
            return [];
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ authMode: "disabled" });
      expect(listHostsCalled).toBe(false);
    });

    it("listHosts() ok -> ok, authMode session, hostCount", async () => {
      const connection = await createFleetConnection("dockhand", "healthy");
      const registry = createFleetHealthSubjectRegistry(
        makeDockhandServices({
          probeSession: async () => ({
            authenticationEnabled: true,
            authenticated: true,
          }),
          listHosts: async () => [
            { externalHostId: "1" } as never,
            { externalHostId: "2" } as never,
          ],
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      // loxep-hb7 Milestone D: the drift cadence's own counts, piggybacked on
      // this SAME read — zero here because no hosting target has declared a
      // container-host intent against this connection in this test.
      expect(outcome?.detail).toEqual({
        authMode: "session",
        hostCount: 2,
        driftingTargetCount: 0,
        unmatchedObservedCount: 0,
      });
    });

    it("listHosts() rejects the credential mid-run -> failing, kind auth", async () => {
      const connection = await createFleetConnection("dockhand", "session-expired");
      const registry = createFleetHealthSubjectRegistry(
        makeDockhandServices({
          probeSession: async () => ({
            authenticationEnabled: true,
            authenticated: false,
          }),
          listHosts: async () => {
            throw new DockhandAdapterError("auth", "session rejected", { httpStatus: 401 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth" });
    });
  });

  describe("dockhand discovery + host address projection (loxep-bub)", () => {
    function dockhandHost(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        externalHostId: "env-1",
        name: "dockhand-target",
        connectionType: "direct",
        host: "192.0.2.5",
        port: 2375,
        labels: [],
        publicIp: "203.0.113.20",
        hawserConfigured: false,
        hawserLastSeen: null,
        updatedAt: null,
        ...overrides,
      };
    }

    function discoveryServices(hosts: Record<string, unknown>[]): FleetHealthServices {
      return fakeServices({
        getDockhandAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "dockhand:test",
          adapter: {
            capabilities: () => ({
              provider: "dockhand",
              readOnly: false,
              authMode: "session",
              unauthenticatedHealthProbe: false,
            }),
            probeSession: async () => ({ authenticationEnabled: true, authenticated: true }),
            listHosts: async () => hosts,
          } as unknown as DockhandAdapter,
          minIntervalSeconds: 300,
        }),
      });
    }

    async function dockhandConnection(label: string): Promise<Connection> {
      return createFleetConnection("dockhand", label, {
        dockhand: { baseUrl: "https://dockhand.example.test" },
      });
    }

    it("lands host/publicIp as kind='other' with distinct provenance, for a name-joined target", async () => {
      const hostingTargets = createHostingTargetsService({ db: handle.db });
      const hostAddresses = createHostAddressesService({ db: handle.db });
      const targetName = `dockhand-name-join-${Date.now()}`;
      const target = await hostingTargets.create({
        name: targetName,
        controlSurface: "none",
      });

      const connection = await dockhandConnection("host-addresses-name-join");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          dockhandHost({
            externalHostId: "env-name-join",
            name: targetName,
            host: "192.0.2.6",
            publicIp: "203.0.113.21",
          }),
        ]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const rows = await hostAddresses.listForTarget(target.id);
      const other = rows.filter((row) => row.kind === "other");
      expect(other).toHaveLength(2);
      expect(new Set(other.map((row) => row.provenance))).toEqual(
        new Set(["observed:dockhand", "observed:dockhand.public_ip"]),
      );
      expect(other.find((row) => row.provenance === "observed:dockhand")?.value).toBe(
        "192.0.2.6",
      );
      expect(
        other.find((row) => row.provenance === "observed:dockhand.public_ip")?.value,
      ).toBe("203.0.113.21");
      // Never auto-classified to 'wan', however public-looking the value —
      // an operator's classify() decides that.
      expect(other.every((row) => row.kind !== "wan")).toBe(true);
    });

    it("skips a host field that is not a valid IP literal (e.g. a hostname)", async () => {
      const hostingTargets = createHostingTargetsService({ db: handle.db });
      const hostAddresses = createHostAddressesService({ db: handle.db });
      const targetName = `dockhand-hostname-${Date.now()}`;
      const target = await hostingTargets.create({ name: targetName, controlSurface: "none" });

      const connection = await dockhandConnection("host-addresses-hostname");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          dockhandHost({
            externalHostId: "env-hostname",
            name: targetName,
            host: "dockhand-daemon.internal.example",
            publicIp: null,
          }),
        ]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const rows = await hostAddresses.listForTarget(target.id);
      expect(rows.filter((row) => row.kind === "other")).toHaveLength(0);
    });

    it("writes nothing to host_addresses for an environment with no matching hosting target", async () => {
      const before = await handle.pool.query<{ count: string }>(
        `select count(*)::text as count from host_addresses where provenance like 'observed:dockhand%'`,
      );
      const connection = await dockhandConnection("host-addresses-unmatched");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          dockhandHost({ externalHostId: "env-unmatched", name: `no-such-target-${Date.now()}` }),
        ]),
      );
      // Must not throw even though there is no linked hosting target at all.
      await expect(
        registry.connection?.probe(handle.db, connection.id),
      ).resolves.toBeDefined();
      const after = await handle.pool.query<{ count: string }>(
        `select count(*)::text as count from host_addresses where provenance like 'observed:dockhand%'`,
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    });
  });

  // ---------------------------------------------------------------------------
  // Gatus
  // ---------------------------------------------------------------------------

  describe("gatus", () => {
    function makeGatusServices(
      adapter: Partial<GatusAdapter>,
      sourceAccountKey = "https://gatus.example.test",
    ): FleetHealthServices {
      return fakeServices({
        getGatusAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey,
          adapter: adapter as GatusAdapter,
          minIntervalSeconds: 300,
        }),
      });
    }

    beforeAll(async () => {
      // Disabled by default so per-test heartbeat opt-in is explicit.
      await settings.set(gatusPushSetting, { enabled: false, baseUrl: null, endpointKey: null, mode: "single" }, {});
    });

    it("probeConfig() throws -> unknown", async () => {
      const connection = await createFleetConnection("gatus", "unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => {
            throw new GatusAdapterError("provider_unavailable", "network error");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("open posture, statuses ok -> ok, posture open", async () => {
      const connection = await createFleetConnection("gatus", "open");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
          listEndpointStatuses: async () => [
            { key: "a", name: null, group: null, success: true, httpStatus: 200, observedAt: null, errorCount: 0 },
            { key: "b", name: null, group: null, success: false, httpStatus: 500, observedAt: null, errorCount: 1 },
          ],
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ posture: "open", endpointCount: 2, failingCount: 1 });
    });

    it("basic posture, statuses ok -> ok, credentialAccepted true", async () => {
      const connection = await createFleetConnection("gatus", "basic-ok");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: false, authenticated: false, mode: "direct" }),
          listEndpointStatuses: async () => [],
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({
        posture: "basic",
        credentialAccepted: true,
        endpointCount: 0,
        failingCount: 0,
      });
    });

    it("basic posture, statuses 401 -> failing, kind auth", async () => {
      const connection = await createFleetConnection("gatus", "basic-rejected");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: false, authenticated: false, mode: "direct" }),
          listEndpointStatuses: async () => {
            throw new GatusAdapterError("auth", "rejected", { httpStatus: 401 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth", posture: "basic" });
    });

    it("basic posture, other statuses error -> failing, that kind and httpStatus", async () => {
      const connection = await createFleetConnection("gatus", "basic-error");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: false, authenticated: false, mode: "direct" }),
          listEndpointStatuses: async () => {
            throw new GatusAdapterError("provider_unavailable", "5xx", { httpStatus: 503 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({
        kind: "provider_unavailable",
        posture: "basic",
        httpStatus: 503,
      });
    });

    it("oidc posture, health() reachable UP -> degraded, never failing", async () => {
      const connection = await createFleetConnection("gatus", "oidc-up");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: true, authenticated: false, mode: "oidc_degraded" }),
          health: async () => ({ reachable: true, status: "UP", httpStatus: 200 }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("degraded");
      expect(outcome?.detail).toEqual({ kind: "oidc_no_server_credential", posture: "oidc" });
    });

    it("oidc posture, health() reachable DOWN -> failing, kind hub_down", async () => {
      const connection = await createFleetConnection("gatus", "oidc-down");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: true, authenticated: false, mode: "oidc_degraded" }),
          health: async () => ({ reachable: true, status: "DOWN", httpStatus: 500 }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "hub_down", hubStatus: "DOWN", posture: "oidc" });
    });

    it("oidc posture, health() throws -> unknown", async () => {
      const connection = await createFleetConnection("gatus", "oidc-unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makeGatusServices({
          probeConfig: async () => ({ oidc: true, authenticated: false, mode: "oidc_degraded" }),
          health: async () => {
            throw new GatusAdapterError("provider_unavailable", "network error");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    describe("the push heartbeat mirror", () => {
      // A UNIQUE base URL per sub-test: connections created by an earlier
      // sub-test in this suite persist in the shared scratch db, and the
      // matching rule counts every gatus connection whose base URL matches
      // the push setting's — a shared base URL across sub-tests would make
      // every test after the first see more than one match.
      let heartbeatSeq = 0;
      function nextHeartbeatBaseUrl(): string {
        heartbeatSeq += 1;
        return `https://gatus-heartbeat-${heartbeatSeq}.example.test`;
      }

      it("is absent when the push setting is disabled", async () => {
        const baseUrl = nextHeartbeatBaseUrl();
        const normalized = normalizeGatusBaseUrl(baseUrl);
        await settings.set(
          gatusPushSetting,
          { enabled: false, baseUrl, endpointKey: "public_loxep", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "heartbeat-disabled", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          makeGatusServices(
            {
              probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
              listEndpointStatuses: async () => [],
            },
            normalized,
          ),
        );
        const outcome = await registry.connection?.probe(handle.db, connection.id);
        expect((outcome?.detail as Record<string, unknown>)["heartbeat"]).toBeUndefined();
      });

      it("reads the configured key from the already-fetched statuses page (source: statuses)", async () => {
        const baseUrl = nextHeartbeatBaseUrl();
        const normalized = normalizeGatusBaseUrl(baseUrl);
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "public_loxep", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "heartbeat-statuses", {
          gatus: { baseUrl },
        });
        let uptimeCalled = false;
        const registry = createFleetHealthSubjectRegistry(
          makeGatusServices(
            {
              probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
              listEndpointStatuses: async () => [
                {
                  key: "public_loxep",
                  name: "loxep",
                  group: "public",
                  success: true,
                  httpStatus: 200,
                  observedAt: "2026-08-13T00:00:00.000Z",
                  errorCount: 0,
                },
              ],
              endpointUptime: async () => {
                uptimeCalled = true;
                return { key: "public_loxep", duration: "24h", uptime: 1 };
              },
            },
            normalized,
          ),
        );
        const outcome = await registry.connection?.probe(handle.db, connection.id);
        expect((outcome?.detail as Record<string, unknown>)["heartbeat"]).toEqual({
          configuredKey: "public_loxep",
          keyFound: true,
          uptime24h: null,
          gatusObservedAt: "2026-08-13T00:00:00.000Z",
          gatusSuccess: true,
          source: "statuses",
        });
        expect(uptimeCalled).toBe(false);
      });

      it("falls back to one uptime GET when the key is absent from the statuses page", async () => {
        const baseUrl = nextHeartbeatBaseUrl();
        const normalized = normalizeGatusBaseUrl(baseUrl);
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "public_loxep", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "heartbeat-paged-out", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          makeGatusServices(
            {
              probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
              listEndpointStatuses: async () => [],
              endpointUptime: async (key: string) => {
                expect(key).toBe("public_loxep");
                return { key, duration: "24h", uptime: 0.987 };
              },
            },
            normalized,
          ),
        );
        const outcome = await registry.connection?.probe(handle.db, connection.id);
        expect((outcome?.detail as Record<string, unknown>)["heartbeat"]).toEqual({
          configuredKey: "public_loxep",
          keyFound: true,
          uptime24h: 0.987,
          gatusObservedAt: null,
          gatusSuccess: null,
          source: "uptime_only",
        });
      });

      it("detects a mismatched endpointKey via a 404 on the uptime route", async () => {
        const baseUrl = nextHeartbeatBaseUrl();
        const normalized = normalizeGatusBaseUrl(baseUrl);
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "wrong_key", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "heartbeat-mismatch", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          makeGatusServices(
            {
              probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
              listEndpointStatuses: async () => [],
              endpointUptime: async () => {
                throw new GatusAdapterError("not_found", "unknown key", { httpStatus: 404 });
              },
            },
            normalized,
          ),
        );
        const outcome = await registry.connection?.probe(handle.db, connection.id);
        expect((outcome?.detail as Record<string, unknown>)["heartbeat"]).toEqual({
          configuredKey: "wrong_key",
          keyFound: false,
          uptime24h: null,
          gatusObservedAt: null,
          gatusSuccess: null,
          source: "uptime_only",
        });
      });

      it("uses uptime_only in oidc posture (no statuses page was ever fetched)", async () => {
        const baseUrl = nextHeartbeatBaseUrl();
        const normalized = normalizeGatusBaseUrl(baseUrl);
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "public_loxep", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "heartbeat-oidc", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          makeGatusServices(
            {
              probeConfig: async () => ({ oidc: true, authenticated: false, mode: "oidc_degraded" }),
              health: async () => ({ reachable: true, status: "UP", httpStatus: 200 }),
              endpointUptime: async () => ({ key: "public_loxep", duration: "24h", uptime: 1 }),
            },
            normalized,
          ),
        );
        const outcome = await registry.connection?.probe(handle.db, connection.id);
        expect((outcome?.detail as Record<string, unknown>)["heartbeat"]).toEqual({
          configuredKey: "public_loxep",
          keyFound: true,
          uptime24h: 1,
          gatusObservedAt: null,
          gatusSuccess: null,
          source: "uptime_only",
        });
      });

      it("is absent when MORE THAN ONE gatus connection matches the push base URL", async () => {
        const baseUrl = nextHeartbeatBaseUrl();
        const normalized = normalizeGatusBaseUrl(baseUrl);
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "public_loxep", mode: "single" },
          {},
        );
        await createFleetConnection("gatus", "heartbeat-ambiguous-a", { gatus: { baseUrl } });
        const connectionB = await createFleetConnection("gatus", "heartbeat-ambiguous-b", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          makeGatusServices(
            {
              probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
              listEndpointStatuses: async () => [],
            },
            normalized,
          ),
        );
        const outcome = await registry.connection?.probe(handle.db, connectionB.id);
        expect((outcome?.detail as Record<string, unknown>)["heartbeat"]).toBeUndefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Gatus discovery + per-endpoint health projection (loxep-1au slice B)
  // ---------------------------------------------------------------------------

  describe("gatus discovery + per-endpoint health projection", () => {
    const GATUS_DISCOVERY_BASE_URL = "https://gatus-discovery.example.test";

    function gatusDiscoveryConnection(label: string): Promise<Connection> {
      return createFleetConnection("gatus", label, { gatus: { baseUrl: GATUS_DISCOVERY_BASE_URL } });
    }

    function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        key: "web_home",
        name: "home",
        group: "web",
        success: true,
        httpStatus: 200,
        observedAt: "2026-08-15T00:00:00.000Z",
        errorCount: 0,
        ...overrides,
      };
    }

    function discoveryServices(statuses: Record<string, unknown>[]): FleetHealthServices {
      return fakeServices({
        getGatusAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: normalizeGatusBaseUrl(GATUS_DISCOVERY_BASE_URL),
          adapter: {
            probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
            listEndpointStatuses: async () => statuses,
          } as unknown as GatusAdapter,
          minIntervalSeconds: 300,
        }),
      });
    }

    it("upserts one external_resources row per endpoint keyed on the RAW key, and two sweeps collapse to one row", async () => {
      const connection = await gatusDiscoveryConnection("discovery-idempotent");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([status({ key: "web_home-idempotent" })]),
      );

      await registry.connection?.probe(handle.db, connection.id);
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const matches = (await resourceLinks.listUnattachedByProvider("gatus")).filter(
        (row) => row.externalId === "web_home-idempotent",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.title).toBe("home");
      expect(matches[0]?.url).toBe(
        `${GATUS_DISCOVERY_BASE_URL}/endpoints/web_home-idempotent`,
      );
      expect(matches[0]?.connectionId).toBe(connection.id);
    });

    it("upserts the full §4.2 metadata payload, verbatim, keyed on the un-split raw key", async () => {
      const connection = await gatusDiscoveryConnection("discovery-metadata");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          status({
            key: "public_status-page",
            name: "status-page",
            group: "public",
            success: false,
            httpStatus: 503,
            observedAt: "2026-08-15T01:00:00.000Z",
            errorCount: 3,
          }),
        ]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("gatus")).find(
        (row) => row.externalId === "public_status-page",
      );
      expect(resource).toBeDefined();
      expect(resource?.metadata["group"]).toBe("public");
      expect(resource?.metadata["observedAt"]).toBe("2026-08-15T01:00:00.000Z");
      expect(resource?.metadata["success"]).toBe(false);
      expect(resource?.metadata["httpStatus"]).toBe(503);
      expect(resource?.metadata["errorCount"]).toBe(3);
      expect(typeof resource?.metadata["readAt"]).toBe("string");
    });

    it("discovers an endpoint but writes NO health row when it is not linked to a hosting target", async () => {
      const connection = await gatusDiscoveryConnection("discovery-unlinked");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([status({ key: "unlinked_endpoint" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("gatus")).find(
        (row) => row.externalId === "unlinked_endpoint",
      );
      expect(resource).toBeDefined();
      const health = createHealthService({ db: handle.db });
      expect(await health.getHealth("external_resource", resource!.id)).toBeNull();
    });

    it.each([
      [true, "ok", {}],
      [false, "failing", { kind: "check_failing", errorCount: 2, httpStatus: 500 }],
      [null, "unknown", { kind: "no_result_recorded" }],
    ] as const)(
      "maps success=%s -> integration_health status %s, for a LINKED endpoint",
      async (success, expectedStatus, expectedDetail) => {
        const label = String(success);
        const connection = await gatusDiscoveryConnection(`discovery-status-${label}`);
        const key = `web_status-${label}`;
        const resourceLinks = createResourceLinksService({ db: handle.db });
        const preRegistered = await resourceLinks.upsertExternalResource({
          provider: "gatus",
          externalType: "endpoint",
          externalId: key,
          connectionId: connection.id,
          url: `${GATUS_DISCOVERY_BASE_URL}/endpoints/${key}`,
          title: "placeholder",
        });
        await resourceLinks.attachLink({
          externalResourceId: preRegistered.id,
          resourceType: "hosting_target",
          resourceId: "00000000-0000-4000-8000-0000000000a1",
          purpose: "uptime_check",
        });

        const registry = createFleetHealthSubjectRegistry(
          discoveryServices([
            status({ key, success, httpStatus: success === false ? 500 : 200, errorCount: success === false ? 2 : 0 }),
          ]),
        );
        await registry.connection?.probe(handle.db, connection.id);

        const health = createHealthService({ db: handle.db });
        const healthRow = await health.getHealth("external_resource", preRegistered.id);
        expect(healthRow?.status).toBe(expectedStatus);
        expect(healthRow?.detail).toEqual(expectedDetail);
        expect(healthRow?.source).toBe("adapter");
      },
    );

    it("an endpoint that vanishes from the sweep, while still linked, becomes unknown/endpoint_missing — the link is kept (Binding Rule 4)", async () => {
      const connection = await gatusDiscoveryConnection("discovery-missing");
      const resourceLinks = createResourceLinksService({ db: handle.db });
      const preRegistered = await resourceLinks.upsertExternalResource({
        provider: "gatus",
        externalType: "endpoint",
        externalId: "web_vanishing",
        connectionId: connection.id,
        url: `${GATUS_DISCOVERY_BASE_URL}/endpoints/web_vanishing`,
        title: "placeholder",
      });
      await resourceLinks.attachLink({
        externalResourceId: preRegistered.id,
        resourceType: "hosting_target",
        resourceId: "00000000-0000-4000-8000-0000000000a2",
        purpose: "uptime_check",
      });

      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([status({ key: "some_other_endpoint" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const health = createHealthService({ db: handle.db });
      const healthRow = await health.getHealth("external_resource", preRegistered.id);
      expect(healthRow?.status).toBe("unknown");
      expect(healthRow?.detail).toEqual({ kind: "endpoint_missing" });

      const stillLinked = await handle.db.query.resourceLinks.findFirst({
        where: (table, { eq }) => eq(table.externalResourceId, preRegistered.id),
      });
      expect(stillLinked).toBeDefined();
    });

    it("keeps a discovered-but-unlinked endpoint rather than deleting it", async () => {
      const connection = await gatusDiscoveryConnection("discovery-kept-unlinked");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([status({ key: "web_kept" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const stillThere = (await resourceLinks.listUnattachedByProvider("gatus")).find(
        (row) => row.externalId === "web_kept",
      );
      expect(stillThere).toBeDefined();
    });

    it("gatus never appears as an external_resource tier-2 sweep candidate (healthPath now null)", async () => {
      const connection = await gatusDiscoveryConnection("discovery-no-tier2-race");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([status({ key: "web_no-tier2-race" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("gatus")).find(
        (row) => row.externalId === "web_no-tier2-race",
      );
      expect(resource).toBeDefined();

      const candidates = await registry.external_resource?.listCandidates(handle.db);
      expect(candidates?.map((candidate) => candidate.subjectId)).not.toContain(resource!.id);
    });

    describe("BINDING RULE 1 quarantine — the push heartbeat endpoint is EXCLUDED from discovery entirely", () => {
      it("never registers an external_resources row for the endpoint matching gatusPushSetting.endpointKey, even when it appears in the statuses page and would otherwise be linkable", async () => {
        const baseUrl = "https://gatus-quarantine.example.test";
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "public_loxep-quarantine", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "quarantine", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          fakeServices({
            getGatusAdapterForConnection: async (id) => ({
              connectionId: id,
              sourceAccountKey: normalizeGatusBaseUrl(baseUrl),
              adapter: {
                probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
                listEndpointStatuses: async () => [
                  status({ key: "public_loxep-quarantine", name: "loxep" }),
                  status({ key: "public_other-endpoint", name: "other" }),
                ],
              } as unknown as GatusAdapter,
              minIntervalSeconds: 300,
            }),
          }),
        );
        await registry.connection?.probe(handle.db, connection.id);

        const resourceLinks = createResourceLinksService({ db: handle.db });
        const quarantined = (await resourceLinks.listUnattachedByProvider("gatus")).find(
          (row) => row.externalId === "public_loxep-quarantine",
        );
        expect(quarantined).toBeUndefined();

        // The sibling endpoint on the SAME connection is unaffected — the
        // exclusion is scoped to the one configured key, not the whole sweep.
        const sibling = (await resourceLinks.listUnattachedByProvider("gatus")).find(
          (row) => row.externalId === "public_other-endpoint",
        );
        expect(sibling).toBeDefined();
      });

      it("quarantines the key even when the heartbeat mirror itself is disabled", async () => {
        const baseUrl = "https://gatus-quarantine-disabled.example.test";
        await settings.set(
          gatusPushSetting,
          { enabled: false, baseUrl, endpointKey: "public_loxep-quarantine-disabled", mode: "single" },
          {},
        );
        const connection = await createFleetConnection("gatus", "quarantine-disabled", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          fakeServices({
            getGatusAdapterForConnection: async (id) => ({
              connectionId: id,
              sourceAccountKey: normalizeGatusBaseUrl(baseUrl),
              adapter: {
                probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
                listEndpointStatuses: async () => [
                  status({ key: "public_loxep-quarantine-disabled", name: "loxep" }),
                ],
              } as unknown as GatusAdapter,
              minIntervalSeconds: 300,
            }),
          }),
        );
        await registry.connection?.probe(handle.db, connection.id);

        const resourceLinks = createResourceLinksService({ db: handle.db });
        const quarantined = (await resourceLinks.listUnattachedByProvider("gatus")).find(
          (row) => row.externalId === "public_loxep-quarantine-disabled",
        );
        expect(quarantined).toBeUndefined();
      });

      it("never becomes an integration_health subject even if it was somehow already registered before the push key was configured", async () => {
        // Defensive: a key registered as an ordinary endpoint BEFORE an
        // operator later reused it as the push key must still never receive a
        // health row from a subsequent sweep — Binding Rule 1 holds
        // regardless of registration order.
        const baseUrl = "https://gatus-quarantine-preexisting.example.test";
        const connection = await createFleetConnection("gatus", "quarantine-preexisting", {
          gatus: { baseUrl },
        });
        const resourceLinks = createResourceLinksService({ db: handle.db });
        const preExisting = await resourceLinks.upsertExternalResource({
          provider: "gatus",
          externalType: "endpoint",
          externalId: "public_loxep-preexisting",
          connectionId: connection.id,
          url: `${baseUrl}/endpoints/public_loxep-preexisting`,
          title: "loxep",
        });
        await resourceLinks.attachLink({
          externalResourceId: preExisting.id,
          resourceType: "hosting_target",
          resourceId: "00000000-0000-4000-8000-0000000000a3",
          purpose: "uptime_check",
        });
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: "public_loxep-preexisting", mode: "single" },
          {},
        );

        const registry = createFleetHealthSubjectRegistry(
          fakeServices({
            getGatusAdapterForConnection: async (id) => ({
              connectionId: id,
              sourceAccountKey: normalizeGatusBaseUrl(baseUrl),
              adapter: {
                probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
                listEndpointStatuses: async () => [
                  status({ key: "public_loxep-preexisting", name: "loxep", success: true }),
                ],
              } as unknown as GatusAdapter,
              minIntervalSeconds: 300,
            }),
          }),
        );
        await registry.connection?.probe(handle.db, connection.id);

        const health = createHealthService({ db: handle.db });
        // Not upgraded to 'ok' by this sweep — the excluded key's health row
        // is never TOUCHED at all, quarantined pre-existing row included.
        expect(await health.getHealth("external_resource", preExisting.id)).toBeNull();
      });

      // loxep-4ah: the quarantine extends to ALL FIVE OQ9 fact keys in
      // `mode: 'facts'` — the base `endpointKey` is a derivation seed only
      // in this mode (never itself pushed to), so it is NOT quarantined;
      // only its five derived keys are.
      it("mode 'facts': quarantines all five derived keys, never the base endpointKey seed, and leaves a sibling endpoint linkable", async () => {
        const baseUrl = "https://gatus-quarantine-facts.example.test";
        const baseKey = "public_loxep-facts";
        const derivedKeys = gatusPushFactKeys(baseKey);
        await settings.set(
          gatusPushSetting,
          { enabled: true, baseUrl, endpointKey: baseKey, mode: "facts" },
          {},
        );
        const connection = await createFleetConnection("gatus", "quarantine-facts", {
          gatus: { baseUrl },
        });
        const registry = createFleetHealthSubjectRegistry(
          discoveryServices([
            status({ key: baseKey, name: "base seed, unpushed" }),
            ...derivedKeys.map((key) => status({ key, name: key })),
            status({ key: "public_other-endpoint-facts", name: "other" }),
          ]),
        );
        await registry.connection?.probe(handle.db, connection.id);

        const resourceLinks = createResourceLinksService({ db: handle.db });
        const unattached = await resourceLinks.listUnattachedByProvider("gatus");

        for (const key of derivedKeys) {
          expect(unattached.find((row) => row.externalId === key)).toBeUndefined();
        }
        // The base key is the derivation SEED in facts mode, never pushed to
        // directly — it is an ordinary, registerable endpoint like any other.
        expect(unattached.find((row) => row.externalId === baseKey)).toBeDefined();
        expect(
          unattached.find((row) => row.externalId === "public_other-endpoint-facts"),
        ).toBeDefined();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Tailscale
  // ---------------------------------------------------------------------------

  describe("tailscale", () => {
    function makeTailscaleServices(
      adapter: Partial<TailscaleAdapter>,
      authMode: "api_access_token" | "oauth_client" = "api_access_token",
    ): FleetHealthServices {
      const full: TailscaleAdapter = {
        capabilities: () => ({
          provider: "tailscale",
          readOnly: true,
          authMode,
          unauthenticatedHealthProbe: false,
        }),
        listDevices: async () => [],
        ...adapter,
      } as TailscaleAdapter;
      return fakeServices({
        getTailscaleAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "tailscale:test",
          adapter: full,
          minIntervalSeconds: 300,
        }),
      });
    }

    /** A minimal `TailscaleDeviceFact` fixture, overridable per test. */
    function device(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        externalDeviceId: "node-1",
        name: "web-1.tailnet.ts.net",
        hostname: "web-1",
        addresses: ["100.64.0.1"],
        online: true,
        lastSeen: null,
        os: "linux",
        authorized: true,
        ...overrides,
      };
    }

    it("listDevices() throws (network-level) -> unknown, never calls projectTailscaleDevices", async () => {
      const connection = await createFleetConnection("tailscale", "unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () => {
            throw new Error("network error");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("listDevices() throws kind 'auth' -> failing, kind auth", async () => {
      const connection = await createFleetConnection("tailscale", "bad-token");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () => {
            throw new TailscaleAdapterError("auth", "rejected");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth", credentialMode: "api_access_token" });
    });

    it("listDevices() throws a non-auth TailscaleAdapterError -> unknown, never failing", async () => {
      const connection = await createFleetConnection("tailscale", "rate-limited");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () => {
            throw new TailscaleAdapterError("rate_limited", "429");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("ok, recorded expiry already past -> degraded, credential_expiry_passed", async () => {
      const connection = await createFleetConnection("tailscale", "expiry-passed", {
        credentialExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () => [device(), device({ externalDeviceId: "node-2" })] as never,
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("degraded");
      expect(outcome?.detail).toEqual({ kind: "credential_expiry_passed" });
    });

    it("ok, recorded expiry <= 14 days away -> degraded, credential_expiring", async () => {
      const connection = await createFleetConnection("tailscale", "expiry-soon", {
        credentialExpiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () => [device()] as never,
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("degraded");
      const detail = outcome?.detail as Record<string, unknown>;
      expect(detail["kind"]).toBe("credential_expiring");
      expect(detail["credentialMode"]).toBe("api_access_token");
      expect(typeof detail["daysRemaining"]).toBe("number");
      expect(detail["daysRemaining"] as number).toBeLessThanOrEqual(14);
    });

    it("ok, expiry recorded but far away -> ok, deviceCount (not degraded)", async () => {
      const connection = await createFleetConnection("tailscale", "expiry-far", {
        credentialExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () =>
            [device(), device({ externalDeviceId: "node-2" }), device({ externalDeviceId: "node-3" })] as never,
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ deviceCount: 3 });
    });

    it("ok, no recorded expiry -> ok, deviceCount", async () => {
      const connection = await createFleetConnection("tailscale", "no-expiry");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          listDevices: async () => [device(), device({ externalDeviceId: "node-2" })] as never,
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ deviceCount: 2 });
    });

    it("ok, oauth_client mode -> ok, authMode oauth_client", async () => {
      const connection = await createFleetConnection("tailscale", "oauth");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices(
          {
            listDevices: async () => [device()] as never,
          },
          "oauth_client",
        ),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ authMode: "oauth_client" });
    });
  });

  // ---------------------------------------------------------------------------
  // Tailscale discovery + per-device health projection (loxep-50t slice B)
  // ---------------------------------------------------------------------------

  describe("tailscale discovery + per-device health projection", () => {
    function tailscaleDiscoveryConnection(label: string): Promise<Connection> {
      return createFleetConnection("tailscale", label);
    }

    function device(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        externalDeviceId: "node-discovery-1",
        name: "hollow.tailnet.ts.net",
        hostname: "hollow",
        addresses: ["100.64.1.2", "fd7a:115c:a1e0::1"],
        online: true,
        lastSeen: null,
        os: "linux",
        authorized: true,
        ...overrides,
      };
    }

    function discoveryServices(devices: Record<string, unknown>[]): FleetHealthServices {
      return fakeServices({
        getTailscaleAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "tailscale:test",
          adapter: {
            capabilities: () => ({
              provider: "tailscale",
              readOnly: true,
              authMode: "api_access_token",
              unauthenticatedHealthProbe: false,
            }),
            listDevices: async () => devices,
          } as unknown as TailscaleAdapter,
          minIntervalSeconds: 300,
        }),
      });
    }

    it("upserts one external_resources row per device keyed on nodeId, and two sweeps collapse to one row", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-idempotent");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([device({ externalDeviceId: "node-idempotent-1" })]),
      );

      await registry.connection?.probe(handle.db, connection.id);
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const matches = (await resourceLinks.listUnattachedByProvider("tailscale")).filter(
        (row) => row.externalId === "node-idempotent-1",
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.title).toBe("hollow.tailnet.ts.net");
      expect(matches[0]?.url).toBe(
        "https://login.tailscale.com/admin/machines/node-idempotent-1",
      );
      expect(matches[0]?.connectionId).toBe(connection.id);
    });

    it("upserts the full §1.3 metadata payload, verbatim", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-metadata");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          device({
            externalDeviceId: "node-metadata",
            name: "db-1.tailnet.ts.net",
            addresses: ["100.64.2.3"],
            online: false,
            lastSeen: "2026-08-14T12:00:00.000Z",
            os: "linux",
            authorized: false,
          }),
        ]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("tailscale")).find(
        (row) => row.externalId === "node-metadata",
      );
      expect(resource).toBeDefined();
      expect(resource?.metadata["online"]).toBe(false);
      expect(resource?.metadata["lastSeen"]).toBe("2026-08-14T12:00:00.000Z");
      expect(resource?.metadata["addresses"]).toEqual(["100.64.2.3"]);
      expect(resource?.metadata["magicDnsName"]).toBe("db-1.tailnet.ts.net");
      expect(resource?.metadata["os"]).toBe("linux");
      expect(resource?.metadata["authorized"]).toBe(false);
      expect(typeof resource?.metadata["observedAt"]).toBe("string");
    });

    it("discovers a device but writes NO health row when it is not linked to a hosting target", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-unlinked");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([device({ externalDeviceId: "node-unlinked" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("tailscale")).find(
        (row) => row.externalId === "node-unlinked",
      );
      expect(resource).toBeDefined();

      const health = createHealthService({ db: handle.db });
      const healthRow = await health.getHealth("external_resource", resource!.id);
      expect(healthRow).toBeNull();
    });

    it("writes a health row ONLY once the device is linked to a hosting target", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-linked");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([device({ externalDeviceId: "node-linked", online: true })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("tailscale")).find(
        (row) => row.externalId === "node-linked",
      );
      expect(resource).toBeDefined();
      await resourceLinks.attachLink({
        externalResourceId: resource!.id,
        resourceType: "hosting_target",
        resourceId: "00000000-0000-4000-8000-000000000001",
        purpose: "private_network",
      });

      // A second sweep is required — the FIRST sweep discovered the device
      // before it was ever linked, so it wrote no health row (see the
      // preceding test); linking does not retroactively backfill one.
      await registry.connection?.probe(handle.db, connection.id);

      const health = createHealthService({ db: handle.db });
      const healthRow = await health.getHealth("external_resource", resource!.id);
      expect(healthRow?.status).toBe("ok");
      expect(healthRow?.source).toBe("adapter");
      expect(healthRow?.detail).toEqual({});

      const hostingTargetRows = await health.listHealth({ subjectType: "hosting_target" });
      expect(hostingTargetRows.some((row) => row.subjectId === resource!.id)).toBe(false);
    });

    it("maps online -> ok and offline -> degraded with lastSeen, for a linked device", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-offline");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          device({ externalDeviceId: "node-offline", online: false, lastSeen: "2026-08-10T00:00:00.000Z" }),
        ]),
      );
      const resourceLinks = createResourceLinksService({ db: handle.db });
      // Pre-register + link BEFORE the probed sweep, so this one sweep both
      // discovers and, being already linked, writes the health row.
      const preRegistered = await resourceLinks.upsertExternalResource({
        provider: "tailscale",
        externalType: "device",
        externalId: "node-offline",
        connectionId: connection.id,
        url: "https://login.tailscale.com/admin/machines/node-offline",
        title: "placeholder",
      });
      await resourceLinks.attachLink({
        externalResourceId: preRegistered.id,
        resourceType: "hosting_target",
        resourceId: "00000000-0000-4000-8000-000000000002",
        purpose: "private_network",
      });

      await registry.connection?.probe(handle.db, connection.id);

      const health = createHealthService({ db: handle.db });
      const healthRow = await health.getHealth("external_resource", preRegistered.id);
      expect(healthRow?.status).toBe("degraded");
      expect(healthRow?.detail).toEqual({
        kind: "device_offline",
        lastSeen: "2026-08-10T00:00:00.000Z",
      });
    });

    it("a device that vanishes from the sweep, while still linked, becomes unknown/device_missing — the link is kept", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-missing");
      const resourceLinks = createResourceLinksService({ db: handle.db });
      const preRegistered = await resourceLinks.upsertExternalResource({
        provider: "tailscale",
        externalType: "device",
        externalId: "node-vanishing",
        connectionId: connection.id,
        url: "https://login.tailscale.com/admin/machines/node-vanishing",
        title: "placeholder",
      });
      await resourceLinks.attachLink({
        externalResourceId: preRegistered.id,
        resourceType: "hosting_target",
        resourceId: "00000000-0000-4000-8000-000000000003",
        purpose: "private_network",
      });

      // This sweep's listDevices() page does NOT include node-vanishing.
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([device({ externalDeviceId: "some-other-node" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const health = createHealthService({ db: handle.db });
      const healthRow = await health.getHealth("external_resource", preRegistered.id);
      expect(healthRow?.status).toBe("unknown");
      expect(healthRow?.detail).toEqual({ kind: "device_missing" });

      // The link itself is never deleted.
      const stillLinked = await handle.db.query.resourceLinks.findFirst({
        where: (table, { eq }) => eq(table.externalResourceId, preRegistered.id),
      });
      expect(stillLinked).toBeDefined();
    });

    it("keeps a discovered-but-unlinked device rather than deleting it — the attach picker's candidate list", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-kept-unlinked");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([device({ externalDeviceId: "node-kept" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const stillThere = (await resourceLinks.listUnattachedByProvider("tailscale")).find(
        (row) => row.externalId === "node-kept",
      );
      expect(stillThere).toBeDefined();
    });

    it("tailscale never appears as an external_resource tier-2 sweep candidate (no healthPath in either era)", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-no-tier2-race");
      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([device({ externalDeviceId: "node-no-tier2-race" })]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const resource = (await resourceLinks.listUnattachedByProvider("tailscale")).find(
        (row) => row.externalId === "node-no-tier2-race",
      );
      expect(resource).toBeDefined();

      const candidates = await registry.external_resource?.listCandidates(handle.db);
      expect(candidates?.map((candidate) => candidate.subjectId)).not.toContain(resource!.id);
    });

    it("refreshes tailnet host_addresses rows for a linked device — never hosting_targets.address_v4/v6 (loxep-bub)", async () => {
      const connection = await tailscaleDiscoveryConnection("discovery-host-addresses");
      const hostingTargets = createHostingTargetsService({ db: handle.db });
      const hostAddresses = createHostAddressesService({ db: handle.db });
      const target = await hostingTargets.create({
        name: `tailscale-linked-${Date.now()}`,
        controlSurface: "none",
      });

      const resourceLinks = createResourceLinksService({ db: handle.db });
      const preRegistered = await resourceLinks.upsertExternalResource({
        provider: "tailscale",
        externalType: "device",
        externalId: "node-host-addresses",
        connectionId: connection.id,
        url: "https://login.tailscale.com/admin/machines/node-host-addresses",
        title: "placeholder",
      });
      await resourceLinks.attachLink({
        externalResourceId: preRegistered.id,
        resourceType: "hosting_target",
        resourceId: target.id,
        purpose: "private_network",
      });

      const registry = createFleetHealthSubjectRegistry(
        discoveryServices([
          device({
            externalDeviceId: "node-host-addresses",
            addresses: ["198.51.100.2", "fd7a:115c:a1e0::2"],
          }),
        ]),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const rows = await hostAddresses.listForTarget(target.id);
      const tailnet = rows.filter((row) => row.kind === "tailnet");
      expect(tailnet).toHaveLength(2);
      expect(new Set(tailnet.map((row) => row.family))).toEqual(new Set(["v4", "v6"]));
      expect(tailnet.every((row) => row.provenance === "observed:tailscale")).toBe(true);
      expect(tailnet.find((row) => row.family === "v4")?.value).toBe("198.51.100.2");

      // A second sweep with a CHANGED address refreshes the same rows rather
      // than accumulating duplicates.
      const registryAgain = createFleetHealthSubjectRegistry(
        discoveryServices([
          device({
            externalDeviceId: "node-host-addresses",
            addresses: ["198.51.100.3", "fd7a:115c:a1e0::2"],
          }),
        ]),
      );
      await registryAgain.connection?.probe(handle.db, connection.id);
      const rowsAfter = await hostAddresses.listForTarget(target.id);
      const tailnetAfter = rowsAfter.filter((row) => row.kind === "tailnet");
      expect(tailnetAfter).toHaveLength(2);
      expect(tailnetAfter.find((row) => row.family === "v4")?.value).toBe("198.51.100.3");

      // The columns this table used to write are gone; confirm the sync never
      // reaches for them under any other name either.
      const reread = await hostingTargets.get(target.id);
      expect(reread).not.toHaveProperty("addressV4");
      expect(reread).not.toHaveProperty("addressV6");
    });
  });

  // ---------------------------------------------------------------------------
  // Termix
  // ---------------------------------------------------------------------------

  describe("termix", () => {
    function makeTermixServices(adapter: Partial<TermixAdapter>): FleetHealthServices {
      return fakeServices({
        getTermixAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "termix:test",
          adapter: adapter as TermixAdapter,
          minIntervalSeconds: 300,
        }),
      });
    }

    it("thrown with no httpStatus -> unknown (nothing answered)", async () => {
      const connection = await createFleetConnection("termix", "unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => {
            throw new TermixAdapterError("provider_unavailable", "network error", {
              errorName: "TypeError",
            });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("thrown kind rate_limited -> degraded", async () => {
      const connection = await createFleetConnection("termix", "throttled");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => {
            throw new TermixAdapterError("rate_limited", "429", { httpStatus: 429 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("degraded");
      expect(outcome?.detail).toEqual({ kind: "rate_limited" });
    });

    it("thrown other kind (with httpStatus, the instance answered) -> failing", async () => {
      const connection = await createFleetConnection("termix", "instance-error");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => {
            throw new TermixAdapterError("provider_unavailable", "500", { httpStatus: 500 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "provider_unavailable", httpStatus: 500 });
    });

    it("authenticated === false, authRejectedStatus unknown -> failing, kind auth only", async () => {
      const connection = await createFleetConnection("termix", "bad-credential");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: false, authRejectedStatus: null }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth" });
    });

    it("authenticated === false, authRejectedStatus 401 -> failing, carries the wrong-password status", async () => {
      const connection = await createFleetConnection("termix", "wrong-password");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: false, authRejectedStatus: 401 }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth", authRejectedStatus: 401 });
    });

    it("authenticated === false, authRejectedStatus 403 -> failing, carries the password-auth-disabled status", async () => {
      const connection = await createFleetConnection("termix", "password-auth-disabled");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: false, authRejectedStatus: 403 }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth", authRejectedStatus: 403 });
    });

    it("authRejectedStatus survives the real write path (guardHealthDetail does not reject the new key)", async () => {
      const connection = await createFleetConnection("termix", "password-auth-disabled-e2e");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: false, authRejectedStatus: 403 }),
        }),
      );
      // A generous cap, same reasoning as the "BINDING RULE 1" test below:
      // this file's shared connection count keeps growing as siblings add
      // fixtures (Tailscale/Gatus discovery alone adds several dozen), and
      // `listConnectionCandidates` gives no ordering guarantee — without
      // this, THIS connection can silently fall outside the sweep's default
      // 50-per-type batch and the assertion below fails on an unrelated
      // connection count, not a real regression.
      await runHealthSweep({ db: handle.db, registry, maxSubjectsPerType: 500 });

      const health = createHealthService({ db: handle.db });
      const row = await health.getHealth("connection", connection.id);
      expect(row?.status).toBe("failing");
      expect(row?.detail).toEqual({ kind: "auth", authRejectedStatus: 403 });
    });

    it("authenticated === true, listHosts() ok -> ok, hostCount + hostsReadable", async () => {
      const connection = await createFleetConnection("termix", "healthy");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: true, authRejectedStatus: null }),
          listHosts: async () => [{ externalHostId: "1" } as never],
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ hostCount: 1, hostsReadable: true });
    });

    it("authenticated === true, listHosts() throws (unschema'd) -> status stays ok", async () => {
      const connection = await createFleetConnection("termix", "unschemad-hosts");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: true, authRejectedStatus: null }),
          listHosts: async () => {
            throw new TermixAdapterError(
              "invalid_request",
              "neither an array nor a recognized wrapped array",
            );
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ hostsReadable: false });
    });
  });

  describe("pangolin (control-plane, not a fleet companion — loxep-acj.5's fold-in)", () => {
    async function createPangolinConnection(label: string): Promise<Connection> {
      return connections.createConnection({
        provider: "pangolin",
        kind: "proxy",
        name: `pangolin ${label}`,
        config: { pangolin: { baseUrl: "https://pangolin.test", orgId: "home-lab" } },
        createdByUserId: "fleet-health-test-user",
      });
    }

    function makePangolinServices(
      adapter: { listOrgs: () => Promise<unknown[]> },
    ): FleetHealthServices {
      // The fixture connection carries orgId "home-lab", so the probe takes
      // the org-scoped listSites path (the root-key-only GET /orgs finding);
      // each test still declares behavior once, via listOrgs, and this
      // delegation keeps that single source of truth.
      const withSites = {
        ...adapter,
        listSites: (_orgId: string) => adapter.listOrgs(),
      };
      return fakeServices({
        getPangolinAdapterForConnection: async (id) => ({
          connectionId: id,
          baseUrl: "https://pangolin.test",
          orgId: "home-lab",
          sourceAccountKey: "pangolin:test",
          adapter: withSites as never,
          minIntervalSeconds: 3600,
        }),
      });
    }

    it("listOrgs() throws with no httpStatus (transport failure) -> unknown, never failing", async () => {
      const connection = await createPangolinConnection("unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makePangolinServices({
          listOrgs: async () => {
            throw new PangolinAdapterError("provider_unavailable", "network error", {
              errorName: "TypeError",
            });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("listOrgs() throws a non-PangolinAdapterError -> unknown (never assumed to be a rejection)", async () => {
      const connection = await createPangolinConnection("weird-throw");
      const registry = createFleetHealthSubjectRegistry(
        makePangolinServices({
          listOrgs: async () => {
            throw new Error("something unrelated");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("listOrgs() throws kind auth WITH httpStatus (the instance answered and rejected the key) -> failing", async () => {
      const connection = await createPangolinConnection("bad-credential");
      const registry = createFleetHealthSubjectRegistry(
        makePangolinServices({
          listOrgs: async () => {
            throw new PangolinAdapterError("auth", "401", { httpStatus: 401 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth" });
    });

    it("listOrgs() throws kind provider_unavailable WITH httpStatus (a 5xx — the instance answered and misbehaved) -> failing", async () => {
      const connection = await createPangolinConnection("hub-5xx");
      const registry = createFleetHealthSubjectRegistry(
        makePangolinServices({
          listOrgs: async () => {
            throw new PangolinAdapterError("provider_unavailable", "500", { httpStatus: 500 });
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "provider_unavailable" });
    });

    it("an org-scoped read succeeds -> ok, detail carries only the site count", async () => {
      const connection = await createPangolinConnection("healthy");
      const registry = createFleetHealthSubjectRegistry(
        makePangolinServices({ listOrgs: async () => [{ orgId: "home-lab" }, { orgId: "second" }] }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ sites: 2 });
    });

    it("the adapter factory itself throwing an AppConfigurationError -> unknown, kind misconfigured", async () => {
      const connection = await createPangolinConnection("no-credential");
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getPangolinAdapterForConnection: () => {
            throw new PangolinCredentialsMissingError(
              "no stored pangolin_credentials for this connection",
            );
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "misconfigured" });
    });

    it("records the sweep's own success/failure bookkeeping — Pangolin has no poll executor, so this probe is its sole writer, exactly like the five fleet siblings", async () => {
      const connection = await createPangolinConnection("bookkeeping");
      const registry = createFleetHealthSubjectRegistry(
        makePangolinServices({
          listOrgs: async () => {
            throw new PangolinAdapterError("auth", "401", { httpStatus: 401 });
          },
        }),
      );
      await runHealthSweep({ db: handle.db, registry, maxSubjectsPerType: 500 });

      const updated = await connections.getConnection(connection.id);
      expect(updated.lastErrorCode).toBe("fleet_auth");
      expect(updated.lastErrorAt).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // The connections-bookkeeping rule (fleet providers are the SOLE writer)
  // ---------------------------------------------------------------------------

  describe("connections.last_success_at / last_error_at / last_error_code", () => {
    it("an ok outcome stamps last_success_at and clears an error status", async () => {
      const connection = await createFleetConnection("beszel", "bookkeeping-ok");
      await connections.recordConnectionFailure(connection.id, { errorCode: "seed_error" });
      const before = await connections.getConnection(connection.id);
      expect(before.status).toBe("error");

      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getBeszelAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "beszel:test",
            adapter: {
              health: async () => ({ reachable: true, httpStatus: 200, message: null }),
              listSystems: async () => [],
            } as unknown as BeszelAdapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const after = await connections.getConnection(connection.id);
      expect(after.status).toBe("active");
      expect(after.lastSuccessAt).not.toBeNull();
    });

    it("a degraded outcome ALSO stamps last_success_at, not last_error_at", async () => {
      const connection = await createFleetConnection("tailscale", "bookkeeping-degraded", {
        credentialExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getTailscaleAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "tailscale:test",
            adapter: {
              listDevices: async () => [
                {
                  externalDeviceId: "node-bookkeeping-1",
                  name: null,
                  hostname: null,
                  addresses: [],
                  online: true,
                  lastSeen: null,
                  os: null,
                  authorized: null,
                },
              ],
              capabilities: () => ({
                provider: "tailscale",
                readOnly: true,
                authMode: "api_access_token",
                unauthenticatedHealthProbe: false,
              }),
            } as unknown as TailscaleAdapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("degraded");

      const after = await connections.getConnection(connection.id);
      expect(after.lastSuccessAt).not.toBeNull();
      expect(after.lastErrorAt).toBeNull();
    });

    it("a failing outcome stamps last_error_at/last_error_code and flips status to error", async () => {
      const connection = await createFleetConnection("termix", "bookkeeping-failing");
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getTermixAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "termix:test",
            adapter: {
              probe: async () => ({ reachable: true, authenticated: false }),
            } as unknown as TermixAdapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const after = await connections.getConnection(connection.id);
      expect(after.status).toBe("error");
      expect(after.lastErrorAt).not.toBeNull();
      expect(after.lastErrorCode).toBe("fleet_auth");
    });

    it("an unknown (unreachable) outcome ALSO stamps last_error_at, not last_success_at", async () => {
      const connection = await createFleetConnection("dockhand", "bookkeeping-unreachable");
      const registry = createFleetHealthSubjectRegistry(
        fakeServices({
          getDockhandAdapterForConnection: async (id) => ({
            connectionId: id,
            sourceAccountKey: "dockhand:test",
            adapter: {
              probeSession: async () => {
                throw new DockhandAdapterError("provider_unavailable", "network error");
              },
            } as unknown as DockhandAdapter,
            minIntervalSeconds: 300,
          }),
        }),
      );
      await registry.connection?.probe(handle.db, connection.id);

      const after = await connections.getConnection(connection.id);
      expect(after.lastErrorAt).not.toBeNull();
      expect(after.lastErrorCode).toBe("fleet_unreachable");
      expect(after.lastSuccessAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Non-fleet fallback
  // ---------------------------------------------------------------------------

  describe("non-fleet providers", () => {
    it("still use @loxep/domain's own derived probeConnection, source probe", async () => {
      const connection = await connections.createConnection({
        provider: "ebay",
        kind: "seller",
        name: "not a fleet provider",
        createdByUserId: "fleet-health-test-user",
      });
      await connections.recordConnectionSuccess(connection.id);

      const registry = createFleetHealthSubjectRegistry(fakeServices());
      // The domain package's own probeConnection never sets HealthProbeOutcome
      // .source (only a fleet-provider outcome does, deliberately, per
      // fleet-health.ts's module doc) — the registry ENTRY's source is what
      // `runHealthSweep` falls back to at write time, so that is what proves
      // this row still lands with source 'probe'.
      expect(registry.connection?.source).toBe("probe");
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.source).toBeUndefined();
      expect(outcome?.detail).toEqual({ provider: "ebay" });
    });

    it("a deleted connection resolves to null (cleared), not a thrown probe failure", async () => {
      const registry = createFleetHealthSubjectRegistry(fakeServices());
      const outcome = await registry.connection?.probe(
        handle.db,
        "00000000-0000-4000-8000-000000000000",
      );
      expect(outcome).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // No fleet probe ever writes a notification
  // ---------------------------------------------------------------------------

  it("no fleet probe writes a notification_deliveries row, including on a failure", async () => {
    const failingConnection = await createFleetConnection("termix", "no-notify-failing");
    const okConnection = await createFleetConnection("beszel", "no-notify-ok");
    const registry = createFleetHealthSubjectRegistry(
      fakeServices({
        getTermixAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "termix:test",
          adapter: {
            probe: async () => ({ reachable: true, authenticated: false }),
          } as unknown as TermixAdapter,
          minIntervalSeconds: 300,
        }),
        getBeszelAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: "beszel:test",
          adapter: {
            health: async () => ({ reachable: true, httpStatus: 200, message: null }),
            listSystems: async () => [],
          } as unknown as BeszelAdapter,
          minIntervalSeconds: 300,
        }),
      }),
    );
    await registry.connection?.probe(handle.db, failingConnection.id);
    await registry.connection?.probe(handle.db, okConnection.id);

    const rows = await handle.pool.query<{ n: string }>(
      "select count(*)::text as n from notification_deliveries",
    );
    expect(Number(rows.rows[0]?.n ?? "0")).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // BINDING RULE 1 — the push heartbeat endpoint is never a health subject
  // ---------------------------------------------------------------------------

  it("BINDING RULE 1: the configured push endpoint key is never an integration_health subject", async () => {
    const baseUrl = "https://gatus-rule1.example.test";
    await settings.set(
      gatusPushSetting,
      { enabled: true, baseUrl, endpointKey: "public_loxep", mode: "single" },
      {},
    );
    const connection = await createFleetConnection("gatus", "rule1", { gatus: { baseUrl } });

    const registry = createFleetHealthSubjectRegistry(
      fakeServices({
        getGatusAdapterForConnection: async (id) => ({
          connectionId: id,
          sourceAccountKey: normalizeGatusBaseUrl(baseUrl),
          adapter: {
            probeConfig: async () => ({ oidc: false, authenticated: true, mode: "direct" }),
            listEndpointStatuses: async () => [
              {
                key: "public_loxep",
                name: "loxep",
                group: "public",
                success: true,
                httpStatus: 200,
                observedAt: "2026-08-13T00:00:00.000Z",
                errorCount: 0,
              },
            ],
          } as unknown as GatusAdapter,
          minIntervalSeconds: 300,
        }),
      }),
    );

    // `result.failed` is deliberately not asserted at zero: this scratch db
    // is shared across the whole describe block above, so it also carries
    // Beszel/Dockhand/Tailscale/Termix connections from earlier tests this
    // registry's fake services do not cover — irrelevant to Rule 1, which is
    // about THIS connection's row and the (permanent) absence of any
    // external_resource row. `maxSubjectsPerType` is raised well past the
    // sweep's own default (50): this file's shared connection count keeps
    // growing as siblings add fixtures (loxep-y64 slice 3's discovery tests
    // alone add a dozen), and `listConnectionCandidates` gives no ordering
    // guarantee — without a generous cap, THIS connection can silently fall
    // outside the probed batch and the assertion below fails on an unrelated
    // connection count, not a Rule 1 regression.
    const result = await runHealthSweep({
      db: handle.db,
      registry,
      maxSubjectsPerType: 500,
    });
    expect(result.probed).toBeGreaterThanOrEqual(1);

    const health = createHealthService({ db: handle.db });
    const connectionRow = await health.getHealth("connection", connection.id);
    expect(connectionRow?.status).toBe("ok");
    expect((connectionRow?.detail["heartbeat"] as Record<string, unknown>)["configuredKey"]).toBe(
      "public_loxep",
    );

    // No `external_resources` row was ever registered FOR THIS CONNECTION —
    // Gatus discovery does not exist yet (unlike Beszel's, loxep-y64 slice
    // 3 — which is why this asserts scoped to `connection.id` rather than
    // "the whole external_resource subject type is empty": this shared
    // scratch db legitimately carries Beszel-provider external_resource rows
    // from earlier tests in this file). Rule 1 requires this connection's
    // heartbeat-mirrored endpoint never becomes a resource or a health
    // subject of any kind.
    const registeredForThisConnection = await handle.db.query.externalResources.findMany({
      where: (table, { eq }) => eq(table.connectionId, connection.id),
    });
    expect(registeredForThisConnection).toEqual([]);
  });
});
