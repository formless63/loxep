/**
 * `targets.ts`'s `updateProxyConnection` — the one write loxep-acj.2 (M2 of
 * the Pangolin chain design) adds to `HostingTargetsService`: editing
 * Loxep's OWN `hosting_targets.proxy_connection_id`/`external_site_id`,
 * never a Pangolin call. Covers the create/list/decommission paths only
 * incidentally, through the fixtures those tests need.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { createHostingTargetsService } from "../src/index.ts";
import type { HostingTargetsService } from "../src/index.ts";
import { createScratchDb, dropScratchDb, scratchDbName, silentLogger } from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_targets");
let handle: DbHandle;
let pangolinConnectionId = "";
let service: HostingTargetsService;

beforeAll(async () => {
  const databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);
  service = createHostingTargetsService({ db: handle.db });

  const connection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('pangolin', 'proxy', 'Pangolin (test)', 'active', '{}')
     returning id`,
  );
  pangolinConnectionId = connection.rows[0]?.id ?? "";
});

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(): string {
  seq += 1;
  return `target-${seq}`;
}

describe("updateProxyConnection", () => {
  it("links a proxy connection and site id to an existing target", async () => {
    const target = await service.create({
      name: nextName(),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.10",
    });
    expect(target.proxyConnectionId).toBeNull();

    const updated = await service.updateProxyConnection(target.id, {
      proxyConnectionId: pangolinConnectionId,
      externalSiteId: "42",
    });
    expect(updated.proxyConnectionId).toBe(pangolinConnectionId);
    expect(updated.externalSiteId).toBe("42");

    const reread = await service.get(target.id);
    expect(reread.proxyConnectionId).toBe(pangolinConnectionId);
    expect(reread.externalSiteId).toBe("42");
  });

  it("clears a previously-linked connection when given null", async () => {
    const target = await service.create({
      name: nextName(),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.11",
      proxyConnectionId: pangolinConnectionId,
      externalSiteId: "7",
    });
    expect(target.proxyConnectionId).toBe(pangolinConnectionId);

    const cleared = await service.updateProxyConnection(target.id, {
      proxyConnectionId: null,
      externalSiteId: null,
    });
    expect(cleared.proxyConnectionId).toBeNull();
    expect(cleared.externalSiteId).toBeNull();
  });

  it("writes an audit_events row in the same transaction", async () => {
    const target = await service.create({
      name: nextName(),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.12",
    });
    await service.updateProxyConnection(target.id, {
      proxyConnectionId: pangolinConnectionId,
      externalSiteId: "9",
      actorUserId: null,
    });

    const events = await handle.pool.query<{ action: string; resource_id: string }>(
      `select action, resource_id from audit_events
         where resource_type = 'hosting_target' and resource_id = $1
           and action = 'infrastructure.hosting_target.update_proxy_connection'`,
      [target.id],
    );
    expect(events.rows).toHaveLength(1);
  });
});

describe("create — the re-expressed hosting_targets_addressable_check (loxep-bub)", () => {
  it("refuses a non-'none', non-fronted target with no inline WAN address", async () => {
    await expect(
      service.create({ name: nextName(), controlSurface: "direct_reverse_proxy" }),
    ).rejects.toThrow(/needs an operator-declared WAN address/);
  });

  it("allows control_surface 'none' with no address", async () => {
    await expect(
      service.create({ name: nextName(), controlSurface: "none" }),
    ).resolves.toMatchObject({ controlSurface: "none" });
  });

  it("writes the inline addressV4/addressV6 as wan/operator_declared/primary host_addresses rows", async () => {
    const target = await service.create({
      name: nextName(),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.15",
      addressV6: "2001:db8::15",
    });
    const rows = await handle.pool.query<{
      kind: string;
      family: string;
      value: string;
      provenance: string;
      is_primary: boolean;
    }>(
      `select kind, family, value::text as value, provenance, is_primary
         from host_addresses where hosting_target_id = $1 order by family`,
      [target.id],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        kind: "wan",
        family: "v4",
        provenance: "operator_declared",
        is_primary: true,
      }),
      expect.objectContaining({
        kind: "wan",
        family: "v6",
        provenance: "operator_declared",
        is_primary: true,
      }),
    ]);
  });
});

describe("assertFrontingNodeIsTerminal — re-expressed against host_addresses", () => {
  it("refuses a fronting node with no WAN-declared address", async () => {
    const bareNode = await service.create({ name: nextName(), controlSurface: "none" });
    await expect(
      service.create({
        name: nextName(),
        controlSurface: "tunnel_client",
        frontedByTargetId: bareNode.id,
      }),
    ).rejects.toThrow(/has no address and cannot front another target/);
  });

  it("accepts a fronting node whose only address is a LATER-declared WAN row (not just inline at create)", async () => {
    const bareNode = await service.create({ name: nextName(), controlSurface: "none" });
    // Declared through the address service, not the create() convenience
    // fields — proving assertFrontingNodeIsTerminal reads host_addresses
    // directly rather than some cached copy from create().
    const { createHostAddressesService } = await import("../src/index.ts");
    await createHostAddressesService({ db: handle.db }).declare(bareNode.id, {
      kind: "wan",
      family: "v4",
      value: "203.0.113.16",
    });

    await expect(
      service.create({
        name: nextName(),
        controlSurface: "tunnel_client",
        frontedByTargetId: bareNode.id,
      }),
    ).resolves.toMatchObject({ controlSurface: "tunnel_client" });
  });

  it("still refuses a LAN-only fronting node — LAN never satisfies the WAN-only rule", async () => {
    const bareNode = await service.create({ name: nextName(), controlSurface: "none" });
    const { createHostAddressesService } = await import("../src/index.ts");
    await createHostAddressesService({ db: handle.db }).declare(bareNode.id, {
      kind: "lan",
      family: "v4",
      value: "192.0.2.16",
    });

    await expect(
      service.create({
        name: nextName(),
        controlSurface: "tunnel_client",
        frontedByTargetId: bareNode.id,
      }),
    ).rejects.toThrow(/has no address and cannot front another target/);
  });
});
