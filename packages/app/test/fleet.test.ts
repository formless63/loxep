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
import { describe, expect, it } from "vitest";
import { planContainerHostOperations } from "@loxep/infrastructure";
import type {
  ContainerHostProviderPort,
  ObservedContainerHost,
} from "@loxep/infrastructure";
import {
  BESZEL_CONNECTION_PROVIDER,
  BESZEL_CREDENTIAL_TYPE,
  DOCKHAND_CONNECTION_PROVIDER,
  DOCKHAND_CREDENTIAL_TYPE,
  containerHostPortFromDockhandAdapter,
} from "../src/fleet.ts";
import type { ContainerHostAdapterLike } from "../src/fleet.ts";

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
  });
});
