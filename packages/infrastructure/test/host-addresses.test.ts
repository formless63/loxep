/**
 * `host-addresses.ts` — declare/classify/set-primary/remove, the observer
 * upsert, the re-expressed `hosting_targets_addressable_check`, and the
 * structural quarantine proof loxep-bub asks for by name: a `tailnet` row
 * present NEVER reaches a record plan.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  createHostAddressesService,
  createHostingTargetsService,
  materializeDesiredRecords,
  wanAddressPair,
} from "../src/index.ts";
import type {
  HostAddressesService,
  HostingTargetsService,
} from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_addresses");
let handle: DbHandle;
let targets: HostingTargetsService;
let addresses: HostAddressesService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  targets = createHostingTargetsService({ db: handle.db });
  addresses = createHostAddressesService({ db: handle.db });
}, 120_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(): string {
  seq += 1;
  return `addr-target-${seq}`;
}

async function makeTarget(overrides: { addressV4?: string } = {}) {
  return targets.create({
    name: nextName(),
    controlSurface: "direct_reverse_proxy",
    addressV4: overrides.addressV4 ?? "203.0.113.10",
  });
}

describe("declare", () => {
  it("writes an operator_declared row and an audit_events entry", async () => {
    const target = await makeTarget();
    const row = await addresses.declare(target.id, {
      kind: "lan",
      family: "v4",
      value: "192.0.2.5",
      actorUserId: null,
    });
    expect(row.kind).toBe("lan");
    expect(row.provenance).toBe("operator_declared");
    expect(row.observedAt).toBeNull();

    const events = await handle.pool.query<{ action: string }>(
      `select action from audit_events
         where resource_type = 'host_address' and resource_id = $1
           and action = 'infrastructure.host_address.declare'`,
      [row.id],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("allows more than one WAN address of the same family", async () => {
    const target = await makeTarget();
    const second = await addresses.declare(target.id, {
      kind: "wan",
      family: "v4",
      value: "203.0.113.11",
    });
    expect(second.isPrimary).toBe(false);

    const list = await addresses.listForTarget(target.id);
    // The one from `create()` plus this one.
    expect(list.filter((row) => row.kind === "wan" && row.family === "v4")).toHaveLength(2);
  });

  it("unsets a prior primary of the same (kind, family) when declaring a new primary", async () => {
    const target = await makeTarget();
    const first = await addresses.declare(target.id, {
      kind: "lan",
      family: "v4",
      value: "192.0.2.6",
      isPrimary: true,
    });
    const second = await addresses.declare(target.id, {
      kind: "lan",
      family: "v4",
      value: "192.0.2.7",
      isPrimary: true,
    });

    const reread = await addresses.get(first.id);
    expect(reread.isPrimary).toBe(false);
    expect(second.isPrimary).toBe(true);
  });
});

describe("classify", () => {
  it("changes kind without ever changing provenance", async () => {
    const target = await makeTarget();
    const observed = await addresses.upsertObserved({
      hostingTargetId: target.id,
      kind: "other",
      family: "v4",
      value: "198.51.100.20",
      provider: "dockhand",
    });
    expect(observed.provenance).toBe("observed:dockhand");

    const classified = await addresses.classify(observed.id, { kind: "lan" });
    expect(classified.kind).toBe("lan");
    expect(classified.provenance).toBe("observed:dockhand");
  });

  it("refuses to leave a non-fronted, non-'none' target with zero WAN-declared rows", async () => {
    const target = await makeTarget();
    const list = await addresses.listForTarget(target.id);
    const wanRow = list.find((row) => row.kind === "wan");
    if (wanRow === undefined) throw new Error("fixture expected a wan row");

    await expect(
      addresses.classify(wanRow.id, { kind: "lan" }),
    ).rejects.toThrow(/needs at least one operator-declared WAN address/);
  });

  it("allows reclassifying away from wan when another WAN-declared row remains", async () => {
    const target = await makeTarget();
    const second = await addresses.declare(target.id, {
      kind: "wan",
      family: "v6",
      value: "2001:db8::20",
    });
    const list = await addresses.listForTarget(target.id);
    const firstWan = list.find((row) => row.kind === "wan" && row.family === "v4");
    if (firstWan === undefined) throw new Error("fixture expected a wan v4 row");

    const reclassified = await addresses.classify(firstWan.id, { kind: "other" });
    expect(reclassified.kind).toBe("other");
    // The v6 WAN row still stands guard.
    expect((await addresses.get(second.id)).kind).toBe("wan");
  });

  it("allows reclassifying a WAN address on a 'none' target freely", async () => {
    const target = await targets.create({ name: nextName(), controlSurface: "none" });
    const declared = await addresses.declare(target.id, {
      kind: "wan",
      family: "v4",
      value: "203.0.113.40",
    });
    await expect(
      addresses.classify(declared.id, { kind: "other" }),
    ).resolves.toMatchObject({ kind: "other" });
  });
});

describe("setPrimary", () => {
  it("moves primary within the same (kind, family) group and writes audit", async () => {
    const target = await makeTarget();
    const second = await addresses.declare(target.id, {
      kind: "wan",
      family: "v4",
      value: "203.0.113.12",
    });
    const promoted = await addresses.setPrimary(second.id, { actorUserId: null });
    expect(promoted.isPrimary).toBe(true);

    const list = await addresses.listForTarget(target.id);
    const wanV4 = list.filter((row) => row.kind === "wan" && row.family === "v4");
    expect(wanV4.filter((row) => row.isPrimary)).toHaveLength(1);

    const events = await handle.pool.query<{ action: string }>(
      `select action from audit_events
         where resource_type = 'host_address' and resource_id = $1
           and action = 'infrastructure.host_address.set_primary'`,
      [second.id],
    );
    expect(events.rows).toHaveLength(1);
  });
});

describe("remove", () => {
  it("deletes a non-load-bearing row and writes audit", async () => {
    const target = await makeTarget();
    const lan = await addresses.declare(target.id, {
      kind: "lan",
      family: "v4",
      value: "192.0.2.8",
    });
    await addresses.remove(lan.id, { actorUserId: null });

    await expect(addresses.get(lan.id)).rejects.toThrow(/not found/);
    const events = await handle.pool.query<{ action: string }>(
      `select action from audit_events
         where resource_type = 'host_address' and resource_id = $1
           and action = 'infrastructure.host_address.remove'`,
      [lan.id],
    );
    expect(events.rows).toHaveLength(1);
  });

  it("refuses to remove the last WAN-declared row of an addressable target", async () => {
    const target = await makeTarget();
    const list = await addresses.listForTarget(target.id);
    const wanRow = list.find((row) => row.kind === "wan");
    if (wanRow === undefined) throw new Error("fixture expected a wan row");

    await expect(addresses.remove(wanRow.id)).rejects.toThrow(
      /needs at least one operator-declared WAN address/,
    );
  });

  it("allows removing the last WAN row once a fronting node covers the target", async () => {
    const fronting = await makeTarget();
    const list = await addresses.listForTarget(fronting.id);
    const wanRow = list.find((row) => row.kind === "wan");
    if (wanRow === undefined) throw new Error("fixture expected a wan row");

    const client = await targets.create({
      name: nextName(),
      controlSurface: "tunnel_client",
      frontedByTargetId: fronting.id,
    });
    const clientWan = await addresses.declare(client.id, {
      kind: "wan",
      family: "v4",
      value: "203.0.113.13",
    });
    // A tunnel client's own address is never published, but declaring one
    // and removing it must still obey the SAME rule an ordinary target does
    // — except this target IS fronted, so removal is allowed.
    await expect(addresses.remove(clientWan.id)).resolves.toBeUndefined();
  });
});

describe("upsertObserved — idempotent per sweep, keyed by (target, kind, family, provider)", () => {
  it("inserts on first observation and refreshes the SAME row on a repeat sweep", async () => {
    const target = await makeTarget();
    const first = await addresses.upsertObserved({
      hostingTargetId: target.id,
      kind: "tailnet",
      family: "v4",
      value: "198.51.100.30",
      provider: "tailscale",
    });
    expect(first.provenance).toBe("observed:tailscale");
    expect(first.observedAt).not.toBeNull();

    const second = await addresses.upsertObserved({
      hostingTargetId: target.id,
      kind: "tailnet",
      family: "v4",
      value: "198.51.100.31",
      provider: "tailscale",
    });
    expect(second.id).toBe(first.id);
    expect(second.value).toBe("198.51.100.31");
    expect(second.observedAt?.getTime()).toBeGreaterThanOrEqual(
      first.observedAt?.getTime() ?? 0,
    );

    const list = await addresses.listForTarget(target.id);
    expect(list.filter((row) => row.kind === "tailnet")).toHaveLength(1);
  });

  it("keeps two providers' observations of the same (kind, family) as separate rows", async () => {
    const target = await makeTarget();
    await addresses.upsertObserved({
      hostingTargetId: target.id,
      kind: "other",
      family: "v4",
      value: "198.51.100.40",
      provider: "dockhand",
    });
    await addresses.upsertObserved({
      hostingTargetId: target.id,
      kind: "other",
      family: "v4",
      value: "198.51.100.41",
      provider: "dockhand.public_ip",
    });

    const list = await addresses.listForTarget(target.id);
    const other = list.filter((row) => row.kind === "other" && row.family === "v4");
    expect(other).toHaveLength(2);
    expect(new Set(other.map((row) => row.provenance))).toEqual(
      new Set(["observed:dockhand", "observed:dockhand.public_ip"]),
    );
  });
});

describe("wanAddressPair — the structural quarantine", () => {
  it("returns null for both families when only a tailnet row exists", () => {
    const pair = wanAddressPair([
      {
        kind: "tailnet",
        family: "v4",
        value: "100.90.1.1",
        provenance: "observed:tailscale",
        isPrimary: true,
      },
      {
        kind: "tailnet",
        family: "v6",
        value: "fd7a:115c:a1e0::5",
        provenance: "observed:tailscale",
        isPrimary: true,
      },
    ]);
    expect(pair).toEqual({ addressV4: null, addressV6: null });
  });

  it("ignores an OBSERVED wan row — provenance, not kind alone, gates the materializer", () => {
    const pair = wanAddressPair([
      {
        kind: "wan",
        family: "v4",
        value: "203.0.113.50",
        provenance: "observed:dockhand",
        isPrimary: true,
      },
    ]);
    expect(pair).toEqual({ addressV4: null, addressV6: null });
  });

  it("picks the primary operator-declared wan row per family, ignoring lan/tailnet/other siblings", () => {
    const pair = wanAddressPair([
      { kind: "lan", family: "v4", value: "192.0.2.9", provenance: "operator_declared", isPrimary: true },
      {
        kind: "wan",
        family: "v4",
        value: "203.0.113.51",
        provenance: "operator_declared",
        isPrimary: false,
      },
      {
        kind: "wan",
        family: "v4",
        value: "203.0.113.52",
        provenance: "operator_declared",
        isPrimary: true,
      },
      {
        kind: "wan",
        family: "v6",
        value: "2001:db8::52",
        provenance: "operator_declared",
        isPrimary: true,
      },
      {
        kind: "tailnet",
        family: "v6",
        value: "fd7a:115c:a1e0::9",
        provenance: "observed:tailscale",
        isPrimary: true,
      },
    ]);
    expect(pair).toEqual({ addressV4: "203.0.113.52", addressV6: "2001:db8::52" });
  });

  it("a tailnet row present NEVER reaches a record plan (loxep-bub's own proof)", () => {
    // The domain has an apex target whose ONLY address, per this list, is a
    // tailnet one. If the quarantine held, the materializer must refuse
    // exactly as it does when no address exists at all — never publish the
    // tailnet value.
    const pair = wanAddressPair([
      {
        kind: "tailnet",
        family: "v4",
        value: "100.64.5.5",
        provenance: "observed:tailscale",
        isPrimary: true,
      },
    ]);
    expect(() =>
      materializeDesiredRecords({
        domain: {
          name: "quarantine.test",
          apexTargetId: "t1",
          apexProxied: false,
          wildcardProxied: false,
          mailEnabled: false,
        },
        targets: new Map([
          [
            "t1",
            {
              id: "t1",
              name: "tailnet-only",
              controlSurface: "direct_reverse_proxy",
              addressV4: pair.addressV4,
              addressV6: pair.addressV6,
              frontedByTargetId: null,
            },
          ],
        ]),
        caaPolicy: { reviewed: false, issuers: [], wildcardIssuers: [], iodef: null },
        mailRecords: null,
        capabilities: { proxying: true, proxiedWildcards: true, proxiableTypes: ["A", "AAAA"] },
      }),
    ).toThrow(/has no address to publish/);
  });
});
