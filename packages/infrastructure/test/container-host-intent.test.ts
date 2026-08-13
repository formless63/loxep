/**
 * The container-host planner: desired state plus an observed inventory in,
 * provider operations out. Pure — no database, no provider, no clock.
 *
 * The property under test that matters most is the one rule 13's carve-out
 * depends on: **the planner can only ever emit `create` and `update` against a
 * host inventory.** There is no operation kind that touches a container, and
 * none that deletes a host.
 */
import { describe, expect, it } from "vitest";
import { planContainerHostOperations } from "../src/index.ts";
import type {
  DesiredContainerHost,
  ObservedContainerHost,
} from "../src/index.ts";

const TLS_KEY = "-----BEGIN PRIVATE KEY-----\nmarker\n-----END PRIVATE KEY-----";

function observed(
  overrides: Partial<ObservedContainerHost> = {},
): ObservedContainerHost {
  return {
    externalHostId: "1",
    name: "vps-fra-01",
    connectionType: "direct",
    host: "10.0.0.5",
    port: 2376,
    protocol: "https",
    socketPath: null,
    tlsConfigured: true,
    tlsSkipVerify: false,
    labels: ["prod", "eu"],
    publicIp: "203.0.113.9",
    hawserConfigured: false,
    hawserLastSeen: null,
    updatedAt: "2026-08-13T07:00:00.000Z",
    ...overrides,
  };
}

function desired(
  overrides: Partial<DesiredContainerHost> = {},
): DesiredContainerHost {
  return {
    hostingTargetId: "11111111-1111-4111-8111-111111111111",
    name: "vps-fra-01",
    connectionType: "direct",
    host: "10.0.0.5",
    port: 2376,
    protocol: "https",
    tlsSkipVerify: false,
    labels: ["prod", "eu"],
    publicIp: "203.0.113.9",
    ...overrides,
  };
}

describe("convergence", () => {
  it("emits nothing when desired and observed already agree", () => {
    const plan = planContainerHostOperations({
      desired: [desired()],
      observed: [observed()],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.unmatchedObserved).toEqual([]);
  });

  it("is label-order insensitive — reordering is not drift", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ labels: ["eu", "prod"] })],
      observed: [observed({ labels: ["prod", "eu"] })],
    });
    expect(plan.operations).toEqual([]);
  });

  it("ignores fields the desired record does not express an opinion about", () => {
    const { socketPath: _drop, ...partial } = desired();
    const plan = planContainerHostOperations({
      desired: [partial as DesiredContainerHost],
      observed: [observed({ socketPath: "/var/run/docker.sock" })],
    });
    expect(plan.operations).toEqual([]);
  });
});

describe("create", () => {
  it("creates a host the provider has never seen", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ name: "vps-hel-01" })],
      observed: [],
    });
    expect(plan.operations).toEqual([
      {
        kind: "create",
        host: {
          name: "vps-hel-01",
          connectionType: "direct",
          host: "10.0.0.5",
          port: 2376,
          protocol: "https",
          tlsSkipVerify: false,
          labels: ["prod", "eu"],
          publicIp: "203.0.113.9",
        },
      },
    ]);
  });

  it("strips the Loxep attribution id out of the provider payload", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ name: "new" })],
      observed: [],
    });
    const [operation] = plan.operations;
    expect(operation?.kind).toBe("create");
    expect(JSON.stringify(operation)).not.toContain("hostingTargetId");
  });

  it("carries TLS material on a create, because the provider needs it to connect", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ name: "new", tlsKey: TLS_KEY })],
      observed: [],
    });
    expect(plan.operations[0]).toMatchObject({
      kind: "create",
      host: { tlsKey: TLS_KEY },
    });
  });
});

describe("update", () => {
  it("sends only the fields that actually differ", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ publicIp: "203.0.113.10" })],
      observed: [observed()],
    });
    expect(plan.operations).toEqual([
      {
        kind: "update",
        externalHostId: "1",
        host: { publicIp: "203.0.113.10" },
      },
    ]);
  });

  it("detects a connection-type change", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ connectionType: "hawser-edge" })],
      observed: [observed()],
    });
    expect(plan.operations[0]).toMatchObject({
      kind: "update",
      host: { connectionType: "hawser-edge" },
    });
  });

  it("detects a label change", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ labels: ["prod", "eu", "gpu"] })],
      observed: [observed()],
    });
    expect(plan.operations[0]).toMatchObject({
      host: { labels: ["prod", "eu", "gpu"] },
    });
  });

  it("does NOT re-send TLS material on every sweep", () => {
    // The observed side reports PRESENCE, never value, so "differs" is
    // unanswerable for secrets. Guessing would re-transmit a private key on
    // every reconcile run.
    const plan = planContainerHostOperations({
      desired: [desired({ publicIp: "203.0.113.10" })],
      observed: [observed({ tlsConfigured: true })],
    });
    expect(JSON.stringify(plan.operations)).not.toContain("tlsKey");
    expect(JSON.stringify(plan.operations)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("does NOT read absent TLS material as an instruction to clear it", () => {
    const plan = planContainerHostOperations({
      desired: [desired()],
      observed: [observed({ tlsConfigured: true })],
    });
    expect(plan.operations).toEqual([]);
  });

  it("sends secret material on an update only when deliberately supplied", () => {
    const plan = planContainerHostOperations({
      desired: [desired({ tlsKey: TLS_KEY })],
      observed: [observed()],
    });
    expect(plan.operations).toEqual([
      { kind: "update", externalHostId: "1", host: { tlsKey: TLS_KEY } },
    ]);
  });
});

describe("what the planner refuses to do", () => {
  it("never emits a delete for a host Loxep does not know about", () => {
    const plan = planContainerHostOperations({
      desired: [],
      observed: [observed({ name: "someone-elses-box" })],
    });
    expect(plan.operations).toEqual([]);
    expect(plan.unmatchedObserved.map((h) => h.name)).toEqual([
      "someone-elses-box",
    ]);
  });

  it("emits only create and update kinds, ever", () => {
    const plan = planContainerHostOperations({
      desired: [
        desired({ name: "a" }),
        desired({ name: "vps-fra-01", publicIp: "203.0.113.99" }),
      ],
      observed: [observed(), observed({ externalHostId: "2", name: "orphan" })],
    });
    for (const operation of plan.operations) {
      expect(["create", "update"]).toContain(operation.kind);
    }
    expect(plan.unmatchedObserved.map((h) => h.name)).toEqual(["orphan"]);
  });

  it("surfaces a rename as an unmatched host rather than a silent recreate", () => {
    // The known limitation of matching on name. It is VISIBLE: the caller sees
    // one create and one unmatched observed host, which is the shape that lets
    // a UI ask "did you rename this?" instead of quietly registering a twin.
    const plan = planContainerHostOperations({
      desired: [desired({ name: "vps-fra-01-renamed" })],
      observed: [observed({ name: "vps-fra-01" })],
    });
    expect(plan.operations.map((o) => o.kind)).toEqual(["create"]);
    expect(plan.unmatchedObserved.map((h) => h.name)).toEqual(["vps-fra-01"]);
  });
});
