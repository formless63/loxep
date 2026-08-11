/**
 * Entity-attribution integration tests: `connections.economic_entity_id` as
 * ADR-0017 business context (never authorization) — set/clear with
 * entity-existence and active-flag validation, list-by-entity and
 * unattributed listings, and audit events recording each change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import type { DbHandle } from "@loxep/db";
import {
  ConnectionNotFoundError,
  EntityInactiveError,
  EntityNotFoundError,
  createConnectionsService,
  createEconomicEntitiesService,
} from "../src/index.ts";
import type {
  ConnectionsService,
  EconomicEntitiesService,
} from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  insertTestUser,
  scratchDbName,
  silentLogger,
  testKeyring,
} from "./helpers.ts";

const MISSING_ID = "00000000-0000-4000-8000-00000000beef";

describe("connection entity attribution", () => {
  const dbName = scratchDbName("loxep_test_domain_attribution");
  let handle: DbHandle;
  let connectionsService: ConnectionsService;
  let entitiesService: EconomicEntitiesService;
  let actorId: string;
  let activeEntityId: string;
  let inactiveEntityId: string;
  let businessConnectionId: string;
  let sharedConnectionId: string;

  beforeAll(async () => {
    const databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    connectionsService = createConnectionsService({
      db: handle.db,
      keyring: testKeyring(1, [1]),
    });
    entitiesService = createEconomicEntitiesService({ db: handle.db });
    actorId = await insertTestUser(handle.db, "user_attribution_actor");

    activeEntityId = (
      await entitiesService.createEntity({ name: "Acme LLC", kind: "llc" })
    ).id;
    inactiveEntityId = (
      await entitiesService.createEntity({ name: "Wound Down", kind: "llc" })
    ).id;
    await entitiesService.deactivateEntity(inactiveEntityId);

    businessConnectionId = (
      await connectionsService.createConnection({
        provider: "ebay",
        kind: "marketplace",
        name: "Business eBay",
        createdByUserId: actorId,
      })
    ).id;
    sharedConnectionId = (
      await connectionsService.createConnection({
        provider: "ntfy",
        kind: "notification",
        name: "Shared ntfy",
        createdByUserId: actorId,
      })
    ).id;
  });

  afterAll(async () => {
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  it("attributes a connection to an active entity", async () => {
    const attributed = await connectionsService.attributeConnection(
      businessConnectionId,
      activeEntityId,
      { actorUserId: actorId, requestId: "req-attr-1" },
    );
    expect(attributed.economicEntityId).toBe(activeEntityId);

    const stored = await handle.pool.query<{
      economic_entity_id: string | null;
    }>("select * from connections where id = $1", [businessConnectionId]);
    expect(stored.rows[0]?.economic_entity_id).toBe(activeEntityId);
  });

  it("rejects attribution to an unknown entity", async () => {
    await expect(
      connectionsService.attributeConnection(sharedConnectionId, MISSING_ID),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });

  it("rejects attribution to a deactivated entity", async () => {
    await expect(
      connectionsService.attributeConnection(
        sharedConnectionId,
        inactiveEntityId,
      ),
    ).rejects.toBeInstanceOf(EntityInactiveError);
  });

  it("rejects attribution on an unknown connection", async () => {
    await expect(
      connectionsService.attributeConnection(MISSING_ID, activeEntityId),
    ).rejects.toBeInstanceOf(ConnectionNotFoundError);
  });

  it("lists connections by entity and unattributed connections", async () => {
    const byEntity =
      await connectionsService.listConnectionsByEntity(activeEntityId);
    expect(byEntity.map((c) => c.id)).toEqual([businessConnectionId]);

    const unattributed =
      await connectionsService.listUnattributedConnections();
    expect(unattributed.map((c) => c.id)).toEqual([sharedConnectionId]);
  });

  it("clears attribution with null (shared/unknown ownership stays valid)", async () => {
    const cleared = await connectionsService.attributeConnection(
      businessConnectionId,
      null,
      { actorUserId: actorId },
    );
    expect(cleared.economicEntityId).toBeNull();
    const unattributed =
      await connectionsService.listUnattributedConnections();
    expect(unattributed.map((c) => c.id).sort()).toEqual(
      [businessConnectionId, sharedConnectionId].sort(),
    );
  });

  it("records each attribution change as an audit event", async () => {
    const audits = await handle.pool.query<{
      resource_id: string;
      actor_user_id: string | null;
      before: { economicEntityId?: string | null };
      after: { economicEntityId?: string | null };
      metadata: { economicEntityId?: string | null };
    }>(
      `select * from audit_events
        where resource_type = 'connection' and action = 'connection.attribute'
        order by occurred_at asc`,
    );
    expect(audits.rowCount).toBe(2);
    const [set, clear] = audits.rows;
    expect(set?.resource_id).toBe(businessConnectionId);
    expect(set?.actor_user_id).toBe(actorId);
    expect(set?.before.economicEntityId).toBeNull();
    expect(set?.after.economicEntityId).toBe(activeEntityId);
    expect(clear?.before.economicEntityId).toBe(activeEntityId);
    expect(clear?.after.economicEntityId).toBeNull();
  });
});
