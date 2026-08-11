/**
 * Economic entities service integration tests: ADR-0017 attribution records
 * with kind text-union validation, parent hierarchy rules (exists /
 * self-parent / cycle / depth), soft deactivation, child counts and tree
 * assembly, and redacted audit events for every mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  DomainValidationError,
  EntityHierarchyError,
  EntityNotFoundError,
  createEconomicEntitiesService,
} from "../src/index.ts";
import type { EconomicEntitiesService } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
} from "./helpers.ts";

describe("economic entities service", () => {
  const dbName = scratchDbName("loxep_test_domain_entities");
  let handle: DbHandle;
  let service: EconomicEntitiesService;
  let actorId: string;
  let llcId: string;
  let dbaId: string;
  let personalId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    service = createEconomicEntitiesService({ db: handle.db });
    actorId = await insertTestUser(handle.db, "user_entities_actor");
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("creates an entity with a valid kind and persists the row", async () => {
    const entity = await service.createEntity(
      { name: "Acme Holdings LLC", kind: "llc", legalName: "Acme Holdings, L.L.C." },
      { actorUserId: actorId, requestId: "req-entity-1" },
    );
    llcId = entity.id;
    expect(entity.kind).toBe("llc");
    expect(entity.active).toBe(true);
    expect(entity.parentEntityId).toBeNull();

    const stored = await handle.pool.query<{ name: string; kind: string }>(
      "select * from economic_entities where id = $1",
      [entity.id],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.name).toBe("Acme Holdings LLC");
    expect(stored.rows[0]?.kind).toBe("llc");
  });

  it("rejects a kind outside the documented text union, persisting nothing", async () => {
    await expect(
      service.createEntity({
        name: "Bad Kind",
        // Deliberately invalid at runtime.
        kind: "megacorp" as never,
      }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    const rows = await handle.pool.query(
      "select * from economic_entities where name = 'Bad Kind'",
    );
    expect(rows.rowCount).toBe(0);
  });

  it("rejects a parent that does not exist", async () => {
    await expect(
      service.createEntity({
        name: "Orphan DBA",
        kind: "assumed_name",
        parentEntityId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it("creates a child beneath an existing parent", async () => {
    const dba = await service.createEntity(
      { name: "Acme Vintage", kind: "assumed_name", parentEntityId: llcId },
      { actorUserId: actorId },
    );
    dbaId = dba.id;
    expect(dba.parentEntityId).toBe(llcId);
  });

  it("rejects self-parenting", async () => {
    await expect(
      service.updateEntity(llcId, { parentEntityId: llcId }),
    ).rejects.toBeInstanceOf(EntityHierarchyError);
  });

  it("rejects a parent assignment that would create a cycle", async () => {
    const grandchild = await service.createEntity({
      name: "Acme Vintage Outlet",
      kind: "operating_unit",
      parentEntityId: dbaId,
    });
    // llc -> dba -> grandchild; pointing llc at grandchild closes the loop.
    await expect(
      service.updateEntity(llcId, { parentEntityId: grandchild.id }),
    ).rejects.toBeInstanceOf(EntityHierarchyError);
  });

  it("updates name/kind/legalName and bumps updatedAt", async () => {
    const before = await service.getEntity(llcId);
    const updated = await service.updateEntity(
      llcId,
      { name: "Acme Holdings", legalName: "Acme Holdings, LLC" },
      { actorUserId: actorId },
    );
    expect(updated.name).toBe("Acme Holdings");
    expect(updated.legalName).toBe("Acme Holdings, LLC");
    expect(updated.kind).toBe("llc");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
  });

  it("rejects updates on unknown entities", async () => {
    await expect(
      service.updateEntity("00000000-0000-4000-8000-000000000001", {
        name: "Ghost",
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it("lists entities with child counts and never filters by user", async () => {
    personalId = (
      await service.createEntity({ name: "Personal", kind: "individual" })
    ).id;
    const list = await service.listEntities();
    const byId = new Map(list.map((entry) => [entry.id, entry]));
    expect(byId.get(llcId)?.childCount).toBe(1);
    expect(byId.get(dbaId)?.childCount).toBe(1);
    expect(byId.get(personalId)?.childCount).toBe(0);
    // Attribution records carry no user/ACL data at all.
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain(actorId);
  });

  it("assembles the parent/child tree", async () => {
    const tree = await service.listTree();
    const rootNames = tree.map((node) => node.entity.name);
    expect(rootNames).toContain("Acme Holdings");
    expect(rootNames).toContain("Personal");
    const acme = tree.find((node) => node.entity.id === llcId);
    expect(acme?.children).toHaveLength(1);
    expect(acme?.children[0]?.entity.id).toBe(dbaId);
    expect(acme?.children[0]?.children[0]?.entity.name).toBe(
      "Acme Vintage Outlet",
    );
  });

  it("deactivates softly and idempotently — the row is never deleted", async () => {
    const deactivated = await service.deactivateEntity(personalId, {
      actorUserId: actorId,
    });
    expect(deactivated.active).toBe(false);
    // Idempotent second call, no extra audit event.
    await service.deactivateEntity(personalId);
    const audits = await handle.pool.query(
      `select * from audit_events
        where resource_type = 'economic_entity'
          and action = 'economic_entity.deactivate'`,
    );
    expect(audits.rowCount).toBe(1);

    const stored = await handle.pool.query<{ active: boolean }>(
      "select * from economic_entities where id = $1",
      [personalId],
    );
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0]?.active).toBe(false);

    const activeOnly = await service.listEntities({ includeInactive: false });
    expect(activeOnly.some((entry) => entry.id === personalId)).toBe(false);
    const all = await service.listEntities();
    expect(all.some((entry) => entry.id === personalId)).toBe(true);
  });

  it("wrote an audit event for every mutation with before/after snapshots", async () => {
    const audits = await handle.pool.query<{
      action: string;
      resource_id: string;
      actor_user_id: string | null;
      before: { name?: string } | null;
      after: { name?: string; active?: boolean } | null;
    }>(
      `select * from audit_events
        where resource_type = 'economic_entity' order by occurred_at asc`,
    );
    const actions = audits.rows.map((row) => row.action);
    expect(actions.filter((a) => a === "economic_entity.create")).toHaveLength(4);
    expect(actions).toContain("economic_entity.update");
    expect(actions).toContain("economic_entity.deactivate");

    const create = audits.rows.find(
      (row) =>
        row.action === "economic_entity.create" && row.resource_id === llcId,
    );
    expect(create?.actor_user_id).toBe(actorId);
    expect(create?.before).toBeNull();
    expect(create?.after?.name).toBe("Acme Holdings LLC");

    const deactivate = audits.rows.find(
      (row) => row.action === "economic_entity.deactivate",
    );
    expect(deactivate?.after?.active).toBe(false);
  });
});
