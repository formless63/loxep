/**
 * The container-host port wrapper, and the identifiers the fleet providers are
 * registered under.
 *
 * ## What this suite guarantees today, and what it does not
 *
 * `@loxep/infrastructure` re-declares the container-host shapes structurally
 * rather than importing them from `@loxep/integration-dockhand`, so the two can
 * drift. The sibling suites catch that by constructing a REAL adapter and
 * assigning it to the port — `infrastructure-mail.test.ts` does exactly that
 * with `PurelymailAdapter`.
 *
 * **This suite cannot yet do the same**, because `@loxep/integration-dockhand`
 * is not a dependency of `@loxep/app` and adding it is a manifest change out of
 * scope for loxep-9j6. So what is asserted here is that the wrapper produces a
 * valid `ContainerHostProviderPort` and that the port's facts feed the planner
 * with no translation step — which catches a drift in
 * `@loxep/infrastructure`, but not one in the Dockhand adapter.
 *
 * See `ContainerHostAdapterLike` in `../src/fleet.ts` for the one-line
 * follow-up that upgrades this into the real compile-time guard.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { user } from "@loxep/db/schema";
import { planContainerHostOperations } from "@loxep/infrastructure";
import type {
  ContainerHostProviderPort,
  ObservedContainerHost,
} from "@loxep/infrastructure";
import {
  createConnectionCredentialsService,
  createConnectionsService,
} from "@loxep/domain";
import type { ConnectionCredentialsService, ConnectionsService } from "@loxep/domain";
import {
  BESZEL_CONNECTION_PROVIDER,
  BESZEL_CREDENTIAL_TYPE,
  BeszelCredentialsMissingError,
  DOCKHAND_CONNECTION_PROVIDER,
  DOCKHAND_CREDENTIAL_TYPE,
  DockhandCredentialsMissingError,
  GATUS_CONNECTION_PROVIDER,
  GATUS_CREDENTIAL_TYPE,
  GatusCredentialsMissingError,
  TAILSCALE_CONNECTION_PROVIDER,
  TAILSCALE_CREDENTIAL_TYPE,
  TailscaleCredentialsMissingError,
  TERMIX_CONNECTION_PROVIDER,
  TERMIX_CREDENTIAL_TYPE,
  TermixCredentialsMissingError,
  containerHostPortFromDockhandAdapter,
  createBeszelAdapterFactory,
  createDockhandAdapterFactory,
  createGatusAdapterFactory,
  createTailscaleAdapterFactory,
  createTermixAdapterFactory,
} from "../src/fleet.ts";
import type { ContainerHostAdapterLike } from "../src/fleet.ts";
import type { BeszelAdapter } from "../../integrations/beszel/src/index.ts";
import type { DockhandAdapter as DockhandReadAdapter } from "../../integrations/dockhand/src/index.ts";
import type { GatusAdapter } from "../../integrations/gatus/src/index.ts";
import type { TailscaleAdapter } from "../../integrations/tailscale/src/index.ts";
import type { TermixAdapter } from "../../integrations/termix/src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, testKeyring } from "./helpers.ts";

/**
 * The facts the Dockhand adapter produces for the fixture environment its own
 * suite uses. Kept identical on purpose: if the adapter's output shape changes,
 * this literal is the second place that has to change, and a reviewer comparing
 * the two files sees the drift the missing import cannot catch yet.
 */
const OBSERVED: ObservedContainerHost = {
  externalHostId: "1",
  name: "vps-fra-01",
  connectionType: "direct",
  host: "10.0.0.5",
  port: 2376,
  protocol: "https",
  socketPath: "/var/run/docker.sock",
  tlsConfigured: true,
  tlsSkipVerify: false,
  labels: ["prod", "eu"],
  publicIp: "203.0.113.9",
  hawserConfigured: true,
  hawserLastSeen: "2026-08-13T07:00:00.000Z",
  updatedAt: "2026-08-13T07:00:00.000Z",
};

function makeAdapter(): ContainerHostAdapterLike & {
  applied: unknown[];
  reads: number;
} {
  const applied: unknown[] = [];
  let reads = 0;
  return {
    applied,
    get reads() {
      return reads;
    },
    async readHosts() {
      reads += 1;
      return [OBSERVED];
    },
    async applyHost(operation) {
      applied.push(operation);
      return {
        kind: operation.kind,
        name: "vps-fra-01",
        status: "applied",
        externalHostId: "1",
      };
    },
    capabilities() {
      return {
        provider: "dockhand",
        hostRegistration: true,
        containerLifecycle: false,
        metricHistory: false,
        bearerTokenAuth: false,
        connectionTypes: ["socket", "direct", "hawser-standard", "hawser-edge"],
      };
    },
  };
}

describe("the container-host port wrapper", () => {
  it("produces a valid ContainerHostProviderPort", () => {
    const port: ContainerHostProviderPort =
      containerHostPortFromDockhandAdapter(makeAdapter());
    expect(typeof port.read).toBe("function");
    expect(typeof port.apply).toBe("function");
    expect(typeof port.capabilities).toBe("function");
    // The port has exactly the design's triple — no lifecycle member exists to
    // forward, on either side of the wrapper.
    expect(Object.keys(port).sort()).toEqual(["apply", "capabilities", "read"]);
  });

  it("forwards read through readHosts, not listHosts", async () => {
    const adapter = makeAdapter();
    const port = containerHostPortFromDockhandAdapter(adapter);
    await port.read();
    expect(adapter.reads).toBe(1);
  });

  it("forwards apply verbatim", async () => {
    const adapter = makeAdapter();
    const port = containerHostPortFromDockhandAdapter(adapter);
    const result = await port.apply({
      kind: "update",
      externalHostId: "1",
      host: { publicIp: "203.0.113.10" },
    });
    expect(result).toEqual({
      kind: "update",
      name: "vps-fra-01",
      status: "applied",
      externalHostId: "1",
    });
    expect(adapter.applied).toEqual([
      { kind: "update", externalHostId: "1", host: { publicIp: "203.0.113.10" } },
    ]);
  });

  it("forwards through explicit method calls, so adapter `this` survives", async () => {
    // A destructured forward would lose the binding and fail only at runtime.
    const adapter: ContainerHostAdapterLike & { base: ObservedContainerHost[] } = {
      base: [OBSERVED],
      async readHosts(this: { base: ObservedContainerHost[] }) {
        return this.base;
      },
      async applyHost() {
        return {
          kind: "create" as const,
          name: "x",
          status: "applied" as const,
          externalHostId: "9",
        };
      },
      capabilities() {
        return {
          provider: "dockhand" as const,
          hostRegistration: true,
          containerLifecycle: false,
          metricHistory: false,
          bearerTokenAuth: false,
          connectionTypes: [],
        };
      },
    };
    const port = containerHostPortFromDockhandAdapter(adapter);
    await expect(port.read()).resolves.toHaveLength(1);
  });

  it("reports capabilities with container lifecycle off", () => {
    const port = containerHostPortFromDockhandAdapter(makeAdapter());
    const capabilities = port.capabilities();
    expect(capabilities.provider).toBe("dockhand");
    expect(capabilities.hostRegistration).toBe(true);
    // Rule 13. A port implementation reporting true here is a bug.
    expect(capabilities.containerLifecycle).toBe(false);
  });
});

describe("port facts feed the planner with no translation step", () => {
  it("converges when desired matches what the port observed", async () => {
    const port = containerHostPortFromDockhandAdapter(makeAdapter());
    const observed = await port.read();
    const plan = planContainerHostOperations({
      desired: [
        {
          hostingTargetId: "11111111-1111-4111-8111-111111111111",
          name: "vps-fra-01",
          connectionType: "direct",
          host: "10.0.0.5",
          port: 2376,
          protocol: "https",
          socketPath: "/var/run/docker.sock",
          tlsSkipVerify: false,
          labels: ["prod", "eu"],
          publicIp: "203.0.113.9",
        },
      ],
      observed,
    });
    expect(plan.operations).toEqual([]);
    expect(plan.unmatchedObserved).toEqual([]);
  });

  it("plans an update the port can apply unchanged", async () => {
    const adapter = makeAdapter();
    const port = containerHostPortFromDockhandAdapter(adapter);
    const observed = await port.read();
    const plan = planContainerHostOperations({
      desired: [
        {
          hostingTargetId: "11111111-1111-4111-8111-111111111111",
          name: "vps-fra-01",
          connectionType: "direct",
          publicIp: "203.0.113.44",
        },
      ],
      observed,
    });
    expect(plan.operations).toHaveLength(1);
    for (const operation of plan.operations) await port.apply(operation);
    expect(adapter.applied).toEqual([
      { kind: "update", externalHostId: "1", host: { publicIp: "203.0.113.44" } },
    ]);
  });
});

describe("provider and credential identifiers", () => {
  it("matches the registered ADR-0019 purposes exactly", () => {
    expect(BESZEL_CONNECTION_PROVIDER).toBe("beszel");
    expect(BESZEL_CREDENTIAL_TYPE).toBe("beszel_credentials");
    expect(DOCKHAND_CONNECTION_PROVIDER).toBe("dockhand");
    expect(DOCKHAND_CREDENTIAL_TYPE).toBe("dockhand_credentials");
    expect(GATUS_CONNECTION_PROVIDER).toBe("gatus");
    expect(GATUS_CREDENTIAL_TYPE).toBe("gatus_credentials");
    expect(TAILSCALE_CONNECTION_PROVIDER).toBe("tailscale");
    expect(TAILSCALE_CREDENTIAL_TYPE).toBe("tailscale_credentials");
    expect(TERMIX_CONNECTION_PROVIDER).toBe("termix");
    expect(TERMIX_CREDENTIAL_TYPE).toBe("termix_credentials");
  });
});

// =============================================================================
// The five fleet adapter factories (loxep-rf4 shared foundation)
// =============================================================================

describe("the five fleet adapter factories", () => {
  const dbName = scratchDbName("loxep_test_app_fleet");
  let handle: DbHandle;
  let connections: ConnectionsService;
  let connectionCredentials: ConnectionCredentialsService;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({
      databaseUrl,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    handle = createDb(databaseUrl);
    const keyring = testKeyring();
    connections = createConnectionsService({ db: handle.db, keyring });
    connectionCredentials = createConnectionCredentialsService({ db: handle.db, keyring });

    await handle.db.insert(user).values({
      id: "fleet-factory-test-user",
      name: "Fleet Factory Test User",
      email: "fleet-factory@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  // ---------------------------------------------------------------------------
  // Beszel
  // ---------------------------------------------------------------------------

  async function createBeszelConnection(label: string): Promise<string> {
    const connection = await connections.createConnection({
      provider: "beszel",
      kind: "fleet_observability",
      name: `beszel instance ${label}`,
      config: { beszel: { baseUrl: "https://beszel.example.test" } },
      createdByUserId: "fleet-factory-test-user",
    });
    await connections.setConnectionCredential(
      connection.id,
      "beszel_credentials",
      { email: `readonly-${label}@example.test`, password: `fake-password-${label}` },
      { actorUserId: "fleet-factory-test-user" },
    );
    return connection.id;
  }

  describe("createBeszelAdapterFactory", () => {
    it("caches one adapter per connection and dedupes repeated lookups", async () => {
      let constructions = 0;
      const factory = createBeszelAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => {
          constructions += 1;
          return {} as BeszelAdapter;
        },
      });
      const connectionA = await createBeszelConnection("a");
      const connectionB = await createBeszelConnection("b");

      const adapterA1 = await factory.getAdapterForConnection(connectionA);
      const adapterA2 = await factory.getAdapterForConnection(connectionA);
      const adapterB = await factory.getAdapterForConnection(connectionB);

      expect(constructions).toBe(2);
      expect(adapterA1.adapter).toBe(adapterA2.adapter);
      expect(adapterA1.adapter).not.toBe(adapterB.adapter);
      expect(adapterA1.sourceAccountKey).not.toBe(adapterB.sourceAccountKey);
    });

    it("invalidate() forces a rebuild, but the rate budget survives it", async () => {
      const rateBudgets: unknown[] = [];
      const factory = createBeszelAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          rateBudgets.push(input.rateBudget);
          return {} as BeszelAdapter;
        },
      });
      const connectionId = await createBeszelConnection("c");
      await factory.getAdapterForConnection(connectionId);
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(rateBudgets).toHaveLength(2);
      // Two builds, ONE rate budget instance — the shared rule every factory
      // in this file follows.
      expect(rateBudgets[0]).toBe(rateBudgets[1]);
    });

    it("resolves the credential fresh on every rebuild, not once at first build", async () => {
      const seenCredentials: Array<{ email: string; password: string }> = [];
      const factory = createBeszelAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          seenCredentials.push(input.credentials);
          return {} as BeszelAdapter;
        },
      });
      const connectionId = await createBeszelConnection("d");
      await factory.getAdapterForConnection(connectionId);

      await connections.setConnectionCredential(
        connectionId,
        "beszel_credentials",
        { email: "rotated@example.test", password: "fake-password-rotated" },
        { actorUserId: "fleet-factory-test-user" },
      );
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(seenCredentials).toHaveLength(2);
      expect(seenCredentials[0]?.email).toBe("readonly-d@example.test");
      expect(seenCredentials[1]?.email).toBe("rotated@example.test");
    });

    it("throws BeszelCredentialsMissingError when the connection has no baseUrl configured", async () => {
      const factory = createBeszelAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as BeszelAdapter,
      });
      const connection = await connections.createConnection({
        provider: "beszel",
        kind: "fleet_observability",
        name: "no base url",
        createdByUserId: "fleet-factory-test-user",
      });
      await connections.setConnectionCredential(
        connection.id,
        "beszel_credentials",
        { email: "x@example.test", password: "fake" },
        { actorUserId: "fleet-factory-test-user" },
      );
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(BeszelCredentialsMissingError);
    });

    it("throws BeszelCredentialsMissingError when no credential is stored", async () => {
      const factory = createBeszelAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as BeszelAdapter,
      });
      const connection = await connections.createConnection({
        provider: "beszel",
        kind: "fleet_observability",
        name: "no credential yet",
        config: { beszel: { baseUrl: "https://beszel.example.test" } },
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(BeszelCredentialsMissingError);
    });

    it("throws when the connection's provider is not 'beszel'", async () => {
      const factory = createBeszelAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as BeszelAdapter,
      });
      const connection = await connections.createConnection({
        provider: "gatus",
        kind: "fleet_observability",
        name: "wrong provider",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(BeszelCredentialsMissingError);
    });
  });

  // ---------------------------------------------------------------------------
  // Dockhand
  // ---------------------------------------------------------------------------

  async function createDockhandConnection(label: string): Promise<string> {
    const connection = await connections.createConnection({
      provider: "dockhand",
      kind: "fleet_observability",
      name: `dockhand instance ${label}`,
      config: { dockhand: { baseUrl: "https://dockhand.example.test" } },
      createdByUserId: "fleet-factory-test-user",
    });
    await connections.setConnectionCredential(
      connection.id,
      "dockhand_credentials",
      { username: `loxep-${label}`, password: `fake-password-${label}` },
      { actorUserId: "fleet-factory-test-user" },
    );
    return connection.id;
  }

  describe("createDockhandAdapterFactory", () => {
    it("caches one adapter per connection and dedupes repeated lookups", async () => {
      let constructions = 0;
      const factory = createDockhandAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => {
          constructions += 1;
          return {} as DockhandReadAdapter;
        },
      });
      const connectionA = await createDockhandConnection("a");
      const connectionB = await createDockhandConnection("b");

      const adapterA1 = await factory.getAdapterForConnection(connectionA);
      const adapterA2 = await factory.getAdapterForConnection(connectionA);
      const adapterB = await factory.getAdapterForConnection(connectionB);

      expect(constructions).toBe(2);
      expect(adapterA1.adapter).toBe(adapterA2.adapter);
      expect(adapterA1.adapter).not.toBe(adapterB.adapter);
    });

    it("invalidate() forces a rebuild, but the rate budget survives it", async () => {
      const rateBudgets: unknown[] = [];
      const factory = createDockhandAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          rateBudgets.push(input.rateBudget);
          return {} as DockhandReadAdapter;
        },
      });
      const connectionId = await createDockhandConnection("c");
      await factory.getAdapterForConnection(connectionId);
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(rateBudgets).toHaveLength(2);
      expect(rateBudgets[0]).toBe(rateBudgets[1]);
    });

    it("resolves the credential fresh on every rebuild", async () => {
      const seenCredentials: Array<{ username: string; password: string }> = [];
      const factory = createDockhandAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          seenCredentials.push(input.credentials);
          return {} as DockhandReadAdapter;
        },
      });
      const connectionId = await createDockhandConnection("d");
      await factory.getAdapterForConnection(connectionId);

      await connections.setConnectionCredential(
        connectionId,
        "dockhand_credentials",
        { username: "loxep-rotated", password: "fake-password-rotated" },
        { actorUserId: "fleet-factory-test-user" },
      );
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(seenCredentials).toHaveLength(2);
      expect(seenCredentials[0]?.username).toBe("loxep-d");
      expect(seenCredentials[1]?.username).toBe("loxep-rotated");
    });

    it("throws DockhandCredentialsMissingError when no credential is stored", async () => {
      const factory = createDockhandAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as DockhandReadAdapter,
      });
      const connection = await connections.createConnection({
        provider: "dockhand",
        kind: "fleet_observability",
        name: "no credential yet",
        config: { dockhand: { baseUrl: "https://dockhand.example.test" } },
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(DockhandCredentialsMissingError);
    });

    it("throws when the connection's provider is not 'dockhand'", async () => {
      const factory = createDockhandAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as DockhandReadAdapter,
      });
      const connection = await connections.createConnection({
        provider: "beszel",
        kind: "fleet_observability",
        name: "wrong provider",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(DockhandCredentialsMissingError);
    });
  });

  // ---------------------------------------------------------------------------
  // Gatus
  // ---------------------------------------------------------------------------

  async function createGatusConnection(
    label: string,
    withCredential: boolean,
  ): Promise<string> {
    const connection = await connections.createConnection({
      provider: "gatus",
      kind: "fleet_observability",
      name: `gatus instance ${label}`,
      config: { gatus: { baseUrl: "https://gatus.example.test" } },
      createdByUserId: "fleet-factory-test-user",
    });
    if (withCredential) {
      await connections.setConnectionCredential(
        connection.id,
        "gatus_credentials",
        { username: `loxep-${label}`, password: `fake-password-${label}` },
        { actorUserId: "fleet-factory-test-user" },
      );
    }
    return connection.id;
  }

  describe("createGatusAdapterFactory", () => {
    it("caches one adapter per connection and dedupes repeated lookups", async () => {
      let constructions = 0;
      const factory = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => {
          constructions += 1;
          return {} as GatusAdapter;
        },
      });
      const connectionA = await createGatusConnection("a", true);
      const connectionB = await createGatusConnection("b", true);

      const adapterA1 = await factory.getAdapterForConnection(connectionA);
      const adapterA2 = await factory.getAdapterForConnection(connectionA);
      const adapterB = await factory.getAdapterForConnection(connectionB);

      expect(constructions).toBe(2);
      expect(adapterA1.adapter).toBe(adapterA2.adapter);
      expect(adapterA1.adapter).not.toBe(adapterB.adapter);
    });

    it("invalidate() forces a rebuild, but the rate budget survives it", async () => {
      const rateBudgets: unknown[] = [];
      const factory = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          rateBudgets.push(input.rateBudget);
          return {} as GatusAdapter;
        },
      });
      const connectionId = await createGatusConnection("c", true);
      await factory.getAdapterForConnection(connectionId);
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(rateBudgets).toHaveLength(2);
      expect(rateBudgets[0]).toBe(rateBudgets[1]);
    });

    it("resolves the credential fresh on every rebuild", async () => {
      const seenCredentials: Array<{ username: string; password: string } | undefined> = [];
      const factory = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          seenCredentials.push(input.credentials);
          return {} as GatusAdapter;
        },
      });
      const connectionId = await createGatusConnection("d", true);
      await factory.getAdapterForConnection(connectionId);

      await connections.setConnectionCredential(
        connectionId,
        "gatus_credentials",
        { username: "loxep-rotated", password: "fake-password-rotated" },
        { actorUserId: "fleet-factory-test-user" },
      );
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(seenCredentials).toHaveLength(2);
      expect(seenCredentials[0]?.username).toBe("loxep-d");
      expect(seenCredentials[1]?.username).toBe("loxep-rotated");
    });

    it("omits credentials ENTIRELY (never an empty pair) when none is stored", async () => {
      const seenCredentials: Array<{ username: string; password: string } | undefined> = [];
      const factory = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          seenCredentials.push(input.credentials);
          return {} as GatusAdapter;
        },
      });
      const connectionId = await createGatusConnection("open", false);
      const resolved = await factory.getAdapterForConnection(connectionId);

      expect(seenCredentials).toEqual([undefined]);
      expect(resolved.sourceAccountKey).toBe("https://gatus.example.test");
    });

    it("refuses to persist a half-empty gatus_credentials pair at all (the atomicity every caller relies on)", async () => {
      const connectionId = await createGatusConnection("half", false);
      await expect(
        connections.setConnectionCredential(
          connectionId,
          "gatus_credentials",
          // Deliberately half-empty — TS's inferred type allows it (both
          // fields are individually optional), but the bundle schema's own
          // `.refine` must reject it at write time. That is exactly what lets
          // `resolveGatusCredentials` treat "present" as "complete": a stored
          // row can never legitimately carry only one half.
          { username: "only-half" },
          { actorUserId: "fleet-factory-test-user" },
        ),
      ).rejects.toThrow();
    });

    it("throws GatusCredentialsMissingError when the connection has no baseUrl configured", async () => {
      const factory = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as GatusAdapter,
      });
      const connection = await connections.createConnection({
        provider: "gatus",
        kind: "fleet_observability",
        name: "no base url",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(GatusCredentialsMissingError);
    });

    it("throws when the connection's provider is not 'gatus'", async () => {
      const factory = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as GatusAdapter,
      });
      const connection = await connections.createConnection({
        provider: "termix",
        kind: "fleet_observability",
        name: "wrong provider",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(GatusCredentialsMissingError);
    });

    it("resolves the registered rate-budget setting via resolveRateBudget, and an explicit override still wins", async () => {
      let resolvedCount = 0;
      const factoryUsingSetting = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        resolveRateBudget: async () => {
          resolvedCount += 1;
          return { capacity: 42, refillPerSecond: 7 };
        },
        createAdapter: () => ({}) as GatusAdapter,
      });
      const connectionId = await createGatusConnection("budget", true);
      await factoryUsingSetting.getAdapterForConnection(connectionId);
      expect(resolvedCount).toBeGreaterThanOrEqual(1);

      let sawResolver = false;
      const factoryWithOverride = createGatusAdapterFactory({
        connections,
        connectionCredentials,
        rateBudget: { capacity: 5, refillPerSecond: 1 },
        resolveRateBudget: async () => {
          sawResolver = true;
          return { capacity: 42, refillPerSecond: 7 };
        },
        createAdapter: () => ({}) as GatusAdapter,
      });
      await factoryWithOverride.getAdapterForConnection(connectionId);
      // An explicit `rateBudget` option wins outright — resolveRateBudget is
      // never even called, matching cloudflare.ts's identical rule.
      expect(sawResolver).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Tailscale
  // ---------------------------------------------------------------------------

  async function createTailscaleConnection(label: string): Promise<string> {
    const connection = await connections.createConnection({
      provider: "tailscale",
      kind: "fleet_observability",
      name: `tailscale tailnet ${label}`,
      config: { tailscale: { tailnet: `${label}.example.ts.net` } },
      createdByUserId: "fleet-factory-test-user",
    });
    await connections.setConnectionCredential(
      connection.id,
      "tailscale_credentials",
      { mode: "api_access_token", apiAccessToken: `fake-token-value-${label}` },
      { actorUserId: "fleet-factory-test-user" },
    );
    return connection.id;
  }

  describe("createTailscaleAdapterFactory", () => {
    it("caches one adapter per connection and dedupes repeated lookups", async () => {
      let constructions = 0;
      const factory = createTailscaleAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => {
          constructions += 1;
          return {} as TailscaleAdapter;
        },
      });
      const connectionA = await createTailscaleConnection("a");
      const connectionB = await createTailscaleConnection("b");

      const adapterA1 = await factory.getAdapterForConnection(connectionA);
      const adapterA2 = await factory.getAdapterForConnection(connectionA);
      const adapterB = await factory.getAdapterForConnection(connectionB);

      expect(constructions).toBe(2);
      expect(adapterA1.adapter).toBe(adapterA2.adapter);
      expect(adapterA1.adapter).not.toBe(adapterB.adapter);
    });

    it("invalidate() forces a rebuild, but the rate budget survives it", async () => {
      const rateBudgets: unknown[] = [];
      const factory = createTailscaleAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          rateBudgets.push(input.rateBudget);
          return {} as TailscaleAdapter;
        },
      });
      const connectionId = await createTailscaleConnection("c");
      await factory.getAdapterForConnection(connectionId);
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(rateBudgets).toHaveLength(2);
      expect(rateBudgets[0]).toBe(rateBudgets[1]);
    });

    it("resolves the credential fresh on every rebuild, and supports BOTH credential modes", async () => {
      const seenCredentials: unknown[] = [];
      const factory = createTailscaleAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          seenCredentials.push(input.credentials);
          return {} as TailscaleAdapter;
        },
      });
      const connectionId = await createTailscaleConnection("d");
      await factory.getAdapterForConnection(connectionId);

      await connections.setConnectionCredential(
        connectionId,
        "tailscale_credentials",
        { mode: "oauth_client", clientId: "k-rotated", clientSecret: "fake-secret-value" },
        { actorUserId: "fleet-factory-test-user" },
      );
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(seenCredentials).toEqual([
        { mode: "api_access_token", apiAccessToken: "fake-token-value-d" },
        { mode: "oauth_client", clientId: "k-rotated", clientSecret: "fake-secret-value" },
      ]);
    });

    it("throws TailscaleCredentialsMissingError when no credential is stored", async () => {
      const factory = createTailscaleAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as TailscaleAdapter,
      });
      const connection = await connections.createConnection({
        provider: "tailscale",
        kind: "fleet_observability",
        name: "no credential yet",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(TailscaleCredentialsMissingError);
    });

    it("throws when the connection's provider is not 'tailscale'", async () => {
      const factory = createTailscaleAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as TailscaleAdapter,
      });
      const connection = await connections.createConnection({
        provider: "dockhand",
        kind: "fleet_observability",
        name: "wrong provider",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(TailscaleCredentialsMissingError);
    });
  });

  // ---------------------------------------------------------------------------
  // Termix
  // ---------------------------------------------------------------------------

  async function createTermixConnection(label: string): Promise<string> {
    const connection = await connections.createConnection({
      provider: "termix",
      kind: "fleet_observability",
      name: `termix instance ${label}`,
      config: { termix: { baseUrl: "https://termix.example.test" } },
      createdByUserId: "fleet-factory-test-user",
    });
    await connections.setConnectionCredential(
      connection.id,
      "termix_credentials",
      { username: `loxep-${label}`, password: `fake-password-${label}` },
      { actorUserId: "fleet-factory-test-user" },
    );
    return connection.id;
  }

  describe("createTermixAdapterFactory", () => {
    it("caches one adapter per connection and dedupes repeated lookups", async () => {
      let constructions = 0;
      const factory = createTermixAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => {
          constructions += 1;
          return {} as TermixAdapter;
        },
      });
      const connectionA = await createTermixConnection("a");
      const connectionB = await createTermixConnection("b");

      const adapterA1 = await factory.getAdapterForConnection(connectionA);
      const adapterA2 = await factory.getAdapterForConnection(connectionA);
      const adapterB = await factory.getAdapterForConnection(connectionB);

      expect(constructions).toBe(2);
      expect(adapterA1.adapter).toBe(adapterA2.adapter);
      expect(adapterA1.adapter).not.toBe(adapterB.adapter);
    });

    it("invalidate() forces a rebuild, but the rate budget survives it", async () => {
      const rateBudgets: unknown[] = [];
      const factory = createTermixAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          rateBudgets.push(input.rateBudget);
          return {} as TermixAdapter;
        },
      });
      const connectionId = await createTermixConnection("c");
      await factory.getAdapterForConnection(connectionId);
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(rateBudgets).toHaveLength(2);
      expect(rateBudgets[0]).toBe(rateBudgets[1]);
    });

    it("resolves the credential fresh on every rebuild", async () => {
      const seenCredentials: Array<{ username: string; password: string }> = [];
      const factory = createTermixAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: (input) => {
          seenCredentials.push(input.credentials);
          return {} as TermixAdapter;
        },
      });
      const connectionId = await createTermixConnection("d");
      await factory.getAdapterForConnection(connectionId);

      await connections.setConnectionCredential(
        connectionId,
        "termix_credentials",
        { username: "loxep-rotated", password: "fake-password-rotated" },
        { actorUserId: "fleet-factory-test-user" },
      );
      factory.invalidate(connectionId);
      await factory.getAdapterForConnection(connectionId);

      expect(seenCredentials).toHaveLength(2);
      expect(seenCredentials[0]?.username).toBe("loxep-d");
      expect(seenCredentials[1]?.username).toBe("loxep-rotated");
    });

    it("throws TermixCredentialsMissingError when no credential is stored", async () => {
      const factory = createTermixAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as TermixAdapter,
      });
      const connection = await connections.createConnection({
        provider: "termix",
        kind: "fleet_observability",
        name: "no credential yet",
        config: { termix: { baseUrl: "https://termix.example.test" } },
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(TermixCredentialsMissingError);
    });

    it("throws when the connection's provider is not 'termix'", async () => {
      const factory = createTermixAdapterFactory({
        connections,
        connectionCredentials,
        createAdapter: () => ({}) as TermixAdapter,
      });
      const connection = await connections.createConnection({
        provider: "tailscale",
        kind: "fleet_observability",
        name: "wrong provider",
        createdByUserId: "fleet-factory-test-user",
      });
      await expect(
        factory.getAdapterForConnection(connection.id),
      ).rejects.toThrowError(TermixCredentialsMissingError);
    });
  });
});
