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
  createSettingsService,
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
import type { TailscaleAdapter } from "@loxep/integration-tailscale";
import { TermixAdapterError } from "@loxep/integration-termix";
import type { TermixAdapter } from "@loxep/integration-termix";
import { createFleetHealthSubjectRegistry } from "../src/fleet-health.ts";
import type { FleetHealthServices } from "../src/fleet-health.ts";
import { BeszelCredentialsMissingError } from "../src/fleet.ts";
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
      getGatusAdapterForConnection: () => notConfigured("Gatus"),
      getTailscaleAdapterForConnection: () => notConfigured("Tailscale"),
      getTermixAdapterForConnection: () => notConfigured("Termix"),
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
      expect(outcome?.detail).toEqual({ authMode: "session", hostCount: 2 });
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
      await settings.set(gatusPushSetting, { enabled: false, baseUrl: null, endpointKey: null }, {});
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
          { enabled: false, baseUrl, endpointKey: "public_loxep" },
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
          { enabled: true, baseUrl, endpointKey: "public_loxep" },
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
          { enabled: true, baseUrl, endpointKey: "public_loxep" },
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
          { enabled: true, baseUrl, endpointKey: "wrong_key" },
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
          { enabled: true, baseUrl, endpointKey: "public_loxep" },
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
          { enabled: true, baseUrl, endpointKey: "public_loxep" },
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

    it("probe() throws (network-level) -> unknown", async () => {
      const connection = await createFleetConnection("tailscale", "unreachable");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          probe: async () => {
            throw new Error("network error");
          },
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("unknown");
      expect(outcome?.detail).toEqual({ kind: "unreachable" });
    });

    it("authenticated === false -> failing, kind auth", async () => {
      const connection = await createFleetConnection("tailscale", "bad-token");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          probe: async () => ({ reachable: true, authenticated: false, deviceCount: null }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth", credentialMode: "api_access_token" });
    });

    it("ok, recorded expiry already past -> degraded, credential_expiry_passed", async () => {
      const connection = await createFleetConnection("tailscale", "expiry-passed", {
        credentialExpiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          probe: async () => ({ reachable: true, authenticated: true, deviceCount: 5 }),
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
          probe: async () => ({ reachable: true, authenticated: true, deviceCount: 5 }),
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
          probe: async () => ({ reachable: true, authenticated: true, deviceCount: 7 }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ deviceCount: 7 });
    });

    it("ok, no recorded expiry -> ok, deviceCount", async () => {
      const connection = await createFleetConnection("tailscale", "no-expiry");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices({
          probe: async () => ({ reachable: true, authenticated: true, deviceCount: 3 }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("ok");
      expect(outcome?.detail).toEqual({ deviceCount: 3 });
    });

    it("ok, oauth_client mode -> ok, authMode oauth_client", async () => {
      const connection = await createFleetConnection("tailscale", "oauth");
      const registry = createFleetHealthSubjectRegistry(
        makeTailscaleServices(
          {
            probe: async () => ({ reachable: true, authenticated: true, deviceCount: 9 }),
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

    it("authenticated === false -> failing, kind auth", async () => {
      const connection = await createFleetConnection("termix", "bad-credential");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: false }),
        }),
      );
      const outcome = await registry.connection?.probe(handle.db, connection.id);
      expect(outcome?.status).toBe("failing");
      expect(outcome?.detail).toEqual({ kind: "auth" });
    });

    it("authenticated === true, listHosts() ok -> ok, hostCount + hostsReadable", async () => {
      const connection = await createFleetConnection("termix", "healthy");
      const registry = createFleetHealthSubjectRegistry(
        makeTermixServices({
          probe: async () => ({ reachable: true, authenticated: true }),
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
          probe: async () => ({ reachable: true, authenticated: true }),
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
              probe: async () => ({ reachable: true, authenticated: true, deviceCount: 1 }),
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
      { enabled: true, baseUrl, endpointKey: "public_loxep" },
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
    // external_resource row.
    const result = await runHealthSweep({ db: handle.db, registry });
    expect(result.probed).toBeGreaterThanOrEqual(1);

    const health = createHealthService({ db: handle.db });
    const connectionRow = await health.getHealth("connection", connection.id);
    expect(connectionRow?.status).toBe("ok");
    expect((connectionRow?.detail["heartbeat"] as Record<string, unknown>)["configuredKey"]).toBe(
      "public_loxep",
    );

    // No row of ANY subject type exists for the endpoint itself — this module
    // never registers one (Slice B/per-endpoint discovery is out of this
    // fence's scope), and Rule 1 requires it stays that way permanently.
    const externalResourceRows = await health.listHealth({ subjectType: "external_resource" });
    expect(externalResourceRows).toEqual([]);
  });
});
