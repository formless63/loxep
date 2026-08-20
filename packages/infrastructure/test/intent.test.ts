/**
 * The intent services against real PostgreSQL: managed domains, hosting
 * targets, desired records, and the two properties that are silent when they
 * break.
 *
 * 1. **Transactional enqueue.** The design's pre-implementation checklist item
 *    7: *"assert the transactional-enqueue property with a test that rolls back
 *    an intent change and proves no job survives, because the guarantee is
 *    silent when it breaks."* That test is here, against a REAL Graphile
 *    Worker schema and a real `graphile_worker.add_job` issued through the
 *    Drizzle transaction handle.
 * 2. **The one-hop fronting rule**, which PostgreSQL cannot state
 *    declaratively and which the table's `CHECK` covers only for the trivial
 *    self-loop.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import { makeWorkerUtils } from "graphile-worker";
import { sql } from "drizzle-orm";
import {
  InfrastructureValidationError,
  MATERIALIZE_RECORDS_TASK,
  createHostingTargetsService,
  createManagedDomainsService,
  createRecordingEnqueue,
  createTransactionalEnqueue,
  domainJobKey,
} from "../src/index.ts";
import type {
  HostingTargetsService,
  ManagedDomainsService,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

const dbName = scratchDbName("loxep_test_infra_intent");
let handle: DbHandle;
let databaseUrl = "";
let connectionId = "";
let targets: HostingTargetsService;
let domains: ManagedDomainsService;

beforeAll(async () => {
  databaseUrl = await createScratchDb(dbName);
  await runMigrations({ databaseUrl, logger: silentLogger });
  handle = createDb(databaseUrl);

  // Install the Graphile Worker schema so `graphile_worker.add_job` exists.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.release();

  const connection = await handle.pool.query<{ id: string }>(
    `insert into connections (provider, kind, name, status, config)
     values ('cloudflare', 'dns', 'Cloudflare (test)', 'active', '{"accountId":"acct_test"}')
     returning id`,
  );
  connectionId = connection.rows[0]?.id ?? "";

  targets = createHostingTargetsService({ db: handle.db });
  domains = createManagedDomainsService({
    db: handle.db,
    enqueue: createTransactionalEnqueue(),
  });
}, 180_000);

afterAll(async () => {
  await closeDb(handle);
  await dropScratchDb(dbName);
});

let seq = 0;
function nextName(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

async function jobKeys(prefix: string): Promise<string[]> {
  const result = await handle.pool.query<{ key: string }>(
    `select key from graphile_worker.jobs where key like $1`,
    [`${prefix}%`],
  );
  return result.rows.map((row) => row.key);
}

describe("hosting targets", () => {
  it("creates a directly-addressed target and audits it", async () => {
    const name = nextName("node");
    const row = await targets.create({
      name,
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.10",
    });
    expect(row.name).toBe(name);

    const audit = await handle.pool.query<{ action: string }>(
      `select action from audit_events
        where resource_type = 'hosting_target' and resource_id = $1`,
      [row.id],
    );
    expect(audit.rows.map((entry) => entry.action)).toEqual([
      "infrastructure.hosting_target.create",
    ]);
  });

  it("normalizes an address through inet, and refuses a malformed one", async () => {
    const row = await targets.create({
      name: nextName("inet"),
      controlSurface: "direct_reverse_proxy",
      addressV4: "203.0.113.7/32",
    });
    // PostgreSQL accepts and normalizes the netmask form; the host part is
    // what the materializer publishes either way. The value now lives in
    // `host_addresses`, written by `create()`'s inline-address convenience.
    const address = await handle.pool.query<{ value: string }>(
      `select value::text as value from host_addresses
         where hosting_target_id = $1 and kind = 'wan' and family = 'v4'`,
      [row.id],
    );
    expect(address.rows[0]?.value.startsWith("203.0.113.7")).toBe(true);

    // The whole reason the column is inet rather than text: PostgreSQL
    // refuses the malformed value that would otherwise become a published,
    // unresolvable record. Drizzle wraps the driver error, so the reason lives
    // on `cause`.
    const rejected = await targets
      .create({
        name: nextName("bad"),
        controlSurface: "direct_reverse_proxy",
        addressV4: "not-an-address",
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejected).not.toBeNull();
    expect(
      (rejected as { cause?: { message?: string } }).cause?.message ?? "",
    ).toMatch(/invalid input syntax for type inet/i);
  });

  it("ties tunnel_client to a fronting node in the input schema", async () => {
    await expect(
      targets.create({
        name: nextName("tunnel"),
        controlSurface: "tunnel_client",
        addressV4: "10.0.0.4",
      }),
    ).rejects.toThrow(/tunnel_client/);

    const node = await targets.create({
      name: nextName("front"),
      controlSurface: "proxy_node",
      addressV4: "198.51.100.5",
    });
    await expect(
      targets.create({
        name: nextName("direct"),
        controlSurface: "direct_reverse_proxy",
        addressV4: "203.0.113.10",
        frontedByTargetId: node.id,
      }),
    ).rejects.toThrow(/tunnel_client/);
  });

  it("ENFORCES the one-hop rule the CHECK cannot state", async () => {
    // The table's CHECK blocks only the trivial self-loop; a two-hop chain is
    // structurally insertable and is what the service must refuse.
    const node = await targets.create({
      name: nextName("front"),
      controlSurface: "proxy_node",
      addressV4: "198.51.100.5",
    });
    const client = await targets.create({
      name: nextName("client"),
      controlSurface: "tunnel_client",
      frontedByTargetId: node.id,
    });

    await expect(
      targets.create({
        name: nextName("nested"),
        controlSurface: "tunnel_client",
        frontedByTargetId: client.id,
      }),
    ).rejects.toThrow(InfrastructureValidationError);
  });

  it("refuses a fronting node with no address", async () => {
    const addressless = await targets.create({
      name: nextName("empty"),
      controlSurface: "none",
    });
    await expect(
      targets.create({
        name: nextName("client"),
        controlSurface: "tunnel_client",
        frontedByTargetId: addressless.id,
      }),
    ).rejects.toThrow(/no address/);
  });

  it("refuses a decommissioned fronting node", async () => {
    const node = await targets.create({
      name: nextName("retired"),
      controlSurface: "proxy_node",
      addressV4: "198.51.100.6",
    });
    await targets.decommission(node.id);
    await expect(
      targets.create({
        name: nextName("client"),
        controlSurface: "tunnel_client",
        frontedByTargetId: node.id,
      }),
    ).rejects.toThrow(/decommissioned/);
  });

  it("decommissions rather than deleting, because history is the point", async () => {
    const node = await targets.create({
      name: nextName("gone"),
      controlSurface: "proxy_node",
      addressV4: "198.51.100.7",
    });
    const after = await targets.decommission(node.id, { actorUserId: null });
    expect(after.decommissionedAt).not.toBeNull();
    expect((await targets.get(node.id)).id).toBe(node.id);
  });
});

describe("managed domains", () => {
  it("creates a domain in 'draft' — the service never writes state", async () => {
    const row = await domains.create({
      name: `${nextName("draft")}.test`,
      dnsConnectionId: connectionId,
    });
    expect(row.state).toBe("draft");
    // `state` is not in the input schema at all: the reconciler owns it. The
    // TYPE rejects it (which is why the call below is cast) and the strict zod
    // object rejects it at runtime too, so neither a JS caller nor an HTTP
    // body can force a domain into a state it did not reach.
    await expect(
      domains.create({
        name: `${nextName("forced")}.test`,
        dnsConnectionId: connectionId,
        state: "ready",
      } as unknown as Parameters<typeof domains.create>[0]),
    ).rejects.toThrow();
  });

  it("normalizes the name so one domain cannot become two rows", async () => {
    const base = `${nextName("norm")}.test`;
    const row = await domains.create({
      name: `${base.toUpperCase()}.`,
      dnsConnectionId: connectionId,
    });
    expect(row.name).toBe(base);
    // Drizzle wraps the driver error, so the constraint name lives on `cause`.
    const conflict = await domains
      .create({ name: base, dnsConnectionId: connectionId })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(conflict).not.toBeNull();
    expect(
      (conflict as { cause?: { constraint?: string } }).cause?.constraint,
    ).toBe("managed_domains_name_uq");
  });

  it("records an audit event for every intent change", async () => {
    const row = await domains.create({
      name: `${nextName("audited")}.test`,
      dnsConnectionId: connectionId,
    });
    await domains.updateIntent(row.id, { mailEnabled: false });

    const audit = await handle.pool.query<{ action: string }>(
      `select action from audit_events
        where resource_type = 'managed_domain' and resource_id = $1
        order by occurred_at`,
      [row.id],
    );
    expect(audit.rows.map((entry) => entry.action)).toEqual([
      "infrastructure.managed_domain.create",
      "infrastructure.managed_domain.update_intent",
    ]);
  });

  it("rejects an empty intent update", async () => {
    const row = await domains.create({
      name: `${nextName("empty")}.test`,
      dnsConnectionId: connectionId,
    });
    await expect(domains.updateIntent(row.id, {})).rejects.toThrow();
  });
});

describe("attachZone (loxep-8f8)", () => {
  it("attaches a zone to a domain that has none yet, and enqueues NOTHING", async () => {
    // A fresh service wired to a recording enqueue, so "no job" is proven by
    // the port never being called — not by job-key dedup silently hiding a
    // second (identical) enqueue attempt from `create`'s own first one.
    const recorder = createRecordingEnqueue();
    const service = createManagedDomainsService({
      db: handle.db,
      enqueue: recorder,
    });
    const row = await service.create({
      name: `${nextName("attach")}.test`,
      dnsConnectionId: connectionId,
    });
    expect(row.externalZoneId).toBeNull();
    expect(recorder.calls).toHaveLength(1); // create's own materialize enqueue

    const attached = await service.attachZone(row.id, {
      externalZoneId: "cf-zone-1",
      providerZoneStatus: "active",
      zoneNameservers: ["ns1.example.com", "ns2.example.com"],
    });
    expect(attached.externalZoneId).toBe("cf-zone-1");
    expect(attached.providerZoneStatus).toBe("active");
    expect(attached.zoneNameservers).toEqual([
      "ns1.example.com",
      "ns2.example.com",
    ]);

    // Rule P11 (adopt-into-intent): STILL exactly one call, from `create`.
    // `attachZone` itself never touches the enqueue port.
    expect(recorder.calls).toHaveLength(1);

    const audit = await handle.pool.query<{ action: string }>(
      `select action from audit_events
        where resource_type = 'managed_domain' and resource_id = $1
        order by occurred_at`,
      [row.id],
    );
    expect(audit.rows.map((entry) => entry.action)).toEqual([
      "infrastructure.managed_domain.create",
      "infrastructure.managed_domain.attach_zone",
    ]);
  });

  it("is IDEMPOTENT — re-attaching the SAME zone succeeds and refreshes evidence", async () => {
    const row = await domains.create({
      name: `${nextName("idempotent")}.test`,
      dnsConnectionId: connectionId,
    });
    await domains.attachZone(row.id, {
      externalZoneId: "cf-zone-2",
      providerZoneStatus: "pending",
    });
    const again = await domains.attachZone(row.id, {
      externalZoneId: "cf-zone-2",
      providerZoneStatus: "active",
    });
    expect(again.externalZoneId).toBe("cf-zone-2");
    expect(again.providerZoneStatus).toBe("active");
  });

  it("REFUSES to overwrite a different zone without replace: true", async () => {
    const row = await domains.create({
      name: `${nextName("refuse")}.test`,
      dnsConnectionId: connectionId,
    });
    await domains.attachZone(row.id, { externalZoneId: "cf-zone-3" });
    await expect(
      domains.attachZone(row.id, { externalZoneId: "cf-zone-4" }),
    ).rejects.toThrow(/already attached/);

    const unchanged = await domains.get(row.id);
    expect(unchanged.externalZoneId).toBe("cf-zone-3");
  });

  it("ALLOWS overwriting a different zone when replace: true is explicit", async () => {
    const row = await domains.create({
      name: `${nextName("replace")}.test`,
      dnsConnectionId: connectionId,
    });
    await domains.attachZone(row.id, { externalZoneId: "cf-zone-5" });
    const replaced = await domains.attachZone(row.id, {
      externalZoneId: "cf-zone-6",
      replace: true,
    });
    expect(replaced.externalZoneId).toBe("cf-zone-6");
  });

  it("refuses to attach the SAME external zone id to two different domains", async () => {
    const a = await domains.create({
      name: `${nextName("dup-a")}.test`,
      dnsConnectionId: connectionId,
    });
    const b = await domains.create({
      name: `${nextName("dup-b")}.test`,
      dnsConnectionId: connectionId,
    });
    await domains.attachZone(a.id, { externalZoneId: "cf-zone-shared" });
    await expect(
      domains.attachZone(b.id, { externalZoneId: "cf-zone-shared" }),
    ).rejects.toThrow();
  });
});

describe("transactional enqueue", () => {
  it("commits the intent change and the job together", async () => {
    const row = await domains.create({
      name: `${nextName("enqueued")}.test`,
      dnsConnectionId: connectionId,
    });
    const key = domainJobKey(MATERIALIZE_RECORDS_TASK, row.id);
    expect(await jobKeys(key)).toEqual([key]);
  });

  it("leaves NO JOB BEHIND when the intent change rolls back", async () => {
    // The guarantee ADR-0003 chose Graphile Worker for. It is silent when it
    // breaks — enqueueing through a separate pool client compiles just as
    // well and loses it — so it is asserted rather than commented.
    const row = await domains.create({
      name: `${nextName("rollback")}.test`,
      dnsConnectionId: connectionId,
    });
    const key = domainJobKey("infrastructure.rollback-probe", row.id);
    const enqueue = createTransactionalEnqueue();

    await expect(
      handle.db.transaction(async (tx) => {
        await tx.execute(
          sql`update managed_domains set notes = 'rolled back' where id = ${row.id}`,
        );
        await enqueue(tx, MATERIALIZE_RECORDS_TASK, { domainId: row.id }, {
          jobKey: key,
        });
        throw new Error("deliberate rollback");
      }),
    ).rejects.toThrow("deliberate rollback");

    expect(await jobKeys(key)).toEqual([]);
    const after = await handle.pool.query<{ notes: string | null }>(
      `select notes from managed_domains where id = $1`,
      [row.id],
    );
    expect(after.rows[0]?.notes).toBeNull();
  });

  it("dedupes by job key rather than stacking duplicates", async () => {
    const row = await domains.create({
      name: `${nextName("deduped")}.test`,
      dnsConnectionId: connectionId,
    });
    await domains.updateIntent(row.id, { mailEnabled: false });
    await domains.updateIntent(row.id, { mailEnabled: true });
    const key = domainJobKey(MATERIALIZE_RECORDS_TASK, row.id);
    expect(await jobKeys(key)).toEqual([key]);
  });

  it("never puts a credential in a payload — only a domain id", async () => {
    // Configuration & Secrets rule 5. Graphile Worker payloads sit in a table
    // in cleartext and survive failure, and every task here NEEDS a
    // credential, so the payload is the convenient place to put one.
    const recorder = createRecordingEnqueue();
    const service = createManagedDomainsService({
      db: handle.db,
      enqueue: recorder,
    });
    const row = await service.create({
      name: `${nextName("payload")}.test`,
      dnsConnectionId: connectionId,
    });
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.payload).toEqual({ domainId: row.id });
    expect(Object.keys(recorder.calls[0]?.payload ?? {})).toEqual(["domainId"]);
  });
});

describe("desired records", () => {
  async function freshDomain(): Promise<string> {
    const row = await domains.create({
      name: `${nextName("records")}.test`,
      dnsConnectionId: connectionId,
    });
    return row.id;
  }

  it("writes a materialized set and soft-deletes what intent dropped", async () => {
    const domainId = await freshDomain();
    await domains.applyMaterializedRecords(domainId, [
      {
        type: "A",
        name: "@",
        content: "203.0.113.10",
        ttlSeconds: null,
        priority: null,
        proxied: true,
        owner: "apex",
      },
      {
        type: "A",
        name: "*",
        content: "203.0.113.10",
        ttlSeconds: null,
        priority: null,
        proxied: true,
        owner: "wildcard",
      },
    ]);
    expect(await domains.listRecords(domainId)).toHaveLength(2);

    // Repoint the domain: the old address is no longer described.
    const result = await domains.applyMaterializedRecords(domainId, [
      {
        type: "A",
        name: "@",
        content: "203.0.113.99",
        ttlSeconds: null,
        priority: null,
        proxied: true,
        owner: "apex",
      },
    ]);
    expect(result.created).toBe(1);
    expect(result.softDeleted).toBe(2);
    const live = await domains.listRecords(domainId);
    expect(live.map((row) => row.content)).toEqual(["203.0.113.99"]);
  });

  it("RESURRECTS a soft-deleted record rather than colliding with its tombstone", async () => {
    // Open question 7, PROVISIONAL: the natural-key unique covers tombstones.
    const domainId = await freshDomain();
    const record = {
      type: "A" as const,
      name: "@",
      content: "203.0.113.10",
      ttlSeconds: null,
      priority: null,
      proxied: false,
      owner: "apex" as const,
    };
    await domains.applyMaterializedRecords(domainId, [record]);
    await domains.applyMaterializedRecords(domainId, []);
    expect(await domains.listRecords(domainId)).toHaveLength(0);

    // Re-declaring must clear the tombstone, not insert a second row.
    await domains.applyMaterializedRecords(domainId, [record]);
    const live = await domains.listRecords(domainId);
    expect(live).toHaveLength(1);

    const all = await handle.pool.query<{ count: string }>(
      `select count(*)::text as count from dns_records where domain_id = $1`,
      [domainId],
    );
    expect(all.rows[0]?.count).toBe("1");
  });

  it("NEVER takes ownership of a manual record, even for the same value", async () => {
    const domainId = await freshDomain();
    await domains.addManualRecord(domainId, {
      type: "A",
      name: "@",
      content: "203.0.113.10",
    });
    await domains.applyMaterializedRecords(domainId, [
      {
        type: "A",
        name: "@",
        content: "203.0.113.10",
        ttlSeconds: null,
        priority: null,
        proxied: true,
        owner: "apex",
      },
    ]);
    const live = await domains.listRecords(domainId);
    expect(live).toHaveLength(1);
    expect(live[0]?.owner).toBe("manual");
    expect(live[0]?.proxied).toBe(false);
  });

  it("NEVER soft-deletes a manual record intent does not describe", async () => {
    const domainId = await freshDomain();
    await domains.addManualRecord(domainId, {
      type: "TXT",
      name: "_verification",
      content: "some-vendor-token",
    });
    await domains.applyMaterializedRecords(domainId, []);
    const live = await domains.listRecords(domainId);
    expect(live).toHaveLength(1);
    expect(live[0]?.owner).toBe("manual");
  });

  it("makes a proxied mail record impossible at the database level too", async () => {
    const domainId = await freshDomain();
    await expect(
      handle.pool.query(
        `insert into dns_records (domain_id, type, name, content, owner, proxied)
         values ($1, 'CNAME', 'key1._domainkey', 'key1.provider.test', 'mail', true)`,
        [domainId],
      ),
    ).rejects.toThrow(/dns_records_mail_not_proxied_check/);
  });
});
