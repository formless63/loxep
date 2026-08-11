/**
 * Merge semantics: the survivor pointer, the resolver, the pickers, unmerge,
 * and the two refusals that keep the pointer graph one level deep.
 *
 * The design's pre-implementation checklist asks for this file by name: *"a
 * merged counterparty must not appear in any picker, and every read model must
 * be exercised against a merged pair."*
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CounterpartyMergeError,
  createCounterpartiesService,
  createMergeService,
  createRolesService,
} from "../src/index.ts";
import type {
  CounterpartiesService,
  MergeService,
  RolesService,
} from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedEntity,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("counterparty merge", () => {
  let scratch: ScratchDb;
  let parties: CounterpartiesService;
  let merges: MergeService;
  let roles: RolesService;
  let entityId: string;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_cp_merge");
    parties = createCounterpartiesService({ db: scratch.handle.db });
    merges = createMergeService({ db: scratch.handle.db });
    roles = createRolesService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Loxep LLC");
    actorId = await seedUser(scratch, "merge_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function pair(label: string) {
    const loser = await parties.create({
      kind: "organization",
      displayName: `${label} (duplicate)`,
    });
    const survivor = await parties.create({
      kind: "organization",
      displayName: label,
    });
    return { loser, survivor };
  }

  it("marks the loser and never deletes it", async () => {
    const { loser, survivor } = await pair("Acme Roofing");
    const result = await merges.merge({
      counterpartyId: loser.id,
      survivorId: survivor.id,
      reason: "same business, typed twice",
      actorUserId: actorId,
    });
    expect(result).toMatchObject({
      counterpartyId: loser.id,
      survivorId: survivor.id,
      compressed: [],
    });

    const row = await parties.get(loser.id);
    expect(row.mergedIntoCounterpartyId).toBe(survivor.id);
    expect(row.mergedAt).toBeInstanceOf(Date);
    expect(row.mergedByUserId).toBe(actorId);
    // The row survives, with its own reference code intact.
    expect(row.referenceCode).toBe(loser.referenceCode);
  });

  it("resolves the pointer, and leaves an unmerged id untouched", async () => {
    const { loser, survivor } = await pair("Bravo Supplies");
    expect(await merges.resolve(loser.id)).toBe(loser.id);
    await merges.merge({
      counterpartyId: loser.id,
      survivorId: survivor.id,
    });
    expect(await merges.resolve(loser.id)).toBe(survivor.id);
    expect(await merges.resolve(survivor.id)).toBe(survivor.id);
  });

  it("resolves a batch in input order", async () => {
    const { loser, survivor } = await pair("Charlie Cartage");
    await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
    expect(await merges.resolveMany([survivor.id, loser.id])).toEqual([
      survivor.id,
      survivor.id,
    ]);
    expect(await merges.resolveMany([])).toEqual([]);
  });

  it("getResolved returns the SURVIVING row for a stale id", async () => {
    const { loser, survivor } = await pair("Delta Doors");
    await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
    const resolved = await parties.getResolved(loser.id);
    expect(resolved.id).toBe(survivor.id);
    expect(resolved.displayName).toBe("Delta Doors");
    // `get` still returns the loser — the evidence is reachable on purpose.
    expect((await parties.get(loser.id)).id).toBe(loser.id);
  });

  it("excludes merged rows from every picker", async () => {
    const { loser, survivor } = await pair("Echo Electrical");
    await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });

    const picker = await parties.listForPicker({ search: "Echo" });
    const pickerIds = picker.map((row) => row.id);
    expect(pickerIds).toContain(survivor.id);
    expect(pickerIds).not.toContain(loser.id);

    // `list` also hides them by default, and can be asked for them explicitly.
    const listed = await parties.list({ search: "Echo" });
    expect(listed.map((row) => row.id)).not.toContain(loser.id);
    const withMerged = await parties.list({
      search: "Echo",
      includeMerged: true,
    });
    expect(withMerged.map((row) => row.id)).toContain(loser.id);
  });

  it("excludes an archived row from the picker but not from `list`", async () => {
    const party = await parties.create({
      kind: "organization",
      displayName: "Foxtrot Fabrication",
      status: "archived",
    });
    expect(
      (await parties.listForPicker({ search: "Foxtrot" })).map((r) => r.id),
    ).not.toContain(party.id);
    expect(
      (await parties.list({ search: "Foxtrot" })).map((r) => r.id),
    ).toContain(party.id);
  });

  it("keeps a merged party out of the role picker too", async () => {
    const { loser, survivor } = await pair("Golf Glazing");
    await roles.grant({
      counterpartyId: loser.id,
      economicEntityId: entityId,
      role: "customer",
    });
    await roles.grant({
      counterpartyId: survivor.id,
      economicEntityId: entityId,
      role: "customer",
    });
    await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });

    const customers = await roles.listByEntityRole({
      role: "customer",
      economicEntityId: entityId,
    });
    const ids = customers.map((row) => row.counterpartyId);
    expect(ids).toContain(survivor.id);
    expect(ids).not.toContain(loser.id);
    // The loser's role row still EXISTS; only the read model hides it.
    expect((await roles.listForCounterparty(loser.id)).length).toBe(1);
  });

  it("keeps a merged mirror out of the intercompany report", async () => {
    const { loser, survivor } = await pair("Hotel Holdings");
    await parties.declareMirror({
      counterpartyId: loser.id,
      economicEntityId: entityId,
    });
    await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
    expect(
      (await parties.mirrors()).map((row) => row.counterpartyId),
    ).not.toContain(loser.id);
  });

  describe("refusals that keep the graph one level deep", () => {
    it("refuses a self merge", async () => {
      const party = await parties.create({
        kind: "person",
        displayName: "India Ink",
      });
      await expect(
        merges.merge({
          counterpartyId: party.id,
          survivorId: party.id,
        }),
      ).rejects.toThrow(CounterpartyMergeError);
    });

    it("refuses a DOUBLE merge of an already-merged row", async () => {
      const { loser, survivor } = await pair("Juliet Joinery");
      const third = await parties.create({
        kind: "organization",
        displayName: "Juliet Joinery Ltd",
      });
      await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
      await expect(
        merges.merge({ counterpartyId: loser.id, survivorId: third.id }),
      ).rejects.toThrow(/already merged/);
    });

    it("refuses merging INTO a merged row, which is what forbids a CYCLE", async () => {
      const { loser, survivor } = await pair("Kilo Kitchens");
      await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
      // A -> B is done; B -> A would close a cycle and is refused because the
      // TARGET is merged.
      await expect(
        merges.merge({ counterpartyId: survivor.id, survivorId: loser.id }),
      ).rejects.toThrow(/itself merged/);
    });

    it("compresses existing pointers when a survivor is later merged on", async () => {
      const first = await parties.create({
        kind: "organization",
        displayName: "Lima Logistics A",
      });
      const second = await parties.create({
        kind: "organization",
        displayName: "Lima Logistics B",
      });
      const third = await parties.create({
        kind: "organization",
        displayName: "Lima Logistics C",
      });
      await merges.merge({ counterpartyId: first.id, survivorId: second.id });
      const result = await merges.merge({
        counterpartyId: second.id,
        survivorId: third.id,
        actorUserId: actorId,
      });
      expect(result.compressed).toEqual([first.id]);

      // The documented single-hop formula stays true for BOTH rows.
      expect(await merges.resolve(first.id)).toBe(third.id);
      expect(await merges.resolve(second.id)).toBe(third.id);
      expect(await merges.referencesToMergedRows()).toEqual([]);

      // The evidence the column no longer holds is in the audit trail.
      const events = await auditEventsFor(
        scratch,
        "counterparty.merge_pointer_compressed",
      );
      const event = events.find((row) => row.resourceId === first.id);
      expect(event?.before).toMatchObject({
        mergedIntoCounterpartyId: second.id,
      });
      expect(event?.after).toMatchObject({
        mergedIntoCounterpartyId: third.id,
      });
    });
  });

  describe("unmerge", () => {
    it("restores the loser by clearing one column", async () => {
      const { loser, survivor } = await pair("Mike Masonry");
      await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
      const result = await merges.unmerge({
        counterpartyId: loser.id,
        actorUserId: actorId,
      });
      expect(result.previousSurvivorId).toBe(survivor.id);

      const row = await parties.get(loser.id);
      expect(row.mergedIntoCounterpartyId).toBeNull();
      expect(row.mergedAt).toBeNull();
      expect(row.mergedByUserId).toBeNull();
      expect(await merges.resolve(loser.id)).toBe(loser.id);
      expect(
        (await parties.listForPicker({ search: "Mike" })).map((r) => r.id),
      ).toContain(loser.id);
    });

    it("allows a re-merge after an unmerge", async () => {
      const { loser, survivor } = await pair("November Nurseries");
      await merges.merge({ counterpartyId: loser.id, survivorId: survivor.id });
      await merges.unmerge({ counterpartyId: loser.id });
      await expect(
        merges.merge({ counterpartyId: loser.id, survivorId: survivor.id }),
      ).resolves.toMatchObject({ survivorId: survivor.id });
    });

    it("refuses to unmerge a row that is not merged", async () => {
      const party = await parties.create({
        kind: "person",
        displayName: "Oscar Owner",
      });
      await expect(
        merges.unmerge({ counterpartyId: party.id }),
      ).rejects.toThrow(/is not merged/);
    });
  });

  it("lists the losers of a survivor", async () => {
    const survivor = await parties.create({
      kind: "organization",
      displayName: "Papa Paving",
    });
    const first = await parties.create({
      kind: "organization",
      displayName: "Papa Paving Co",
    });
    const second = await parties.create({
      kind: "organization",
      displayName: "Papa Paving LLC",
    });
    await merges.merge({ counterpartyId: first.id, survivorId: survivor.id });
    await merges.merge({ counterpartyId: second.id, survivorId: survivor.id });
    expect(new Set(await merges.losersOf(survivor.id))).toEqual(
      new Set([first.id, second.id]),
    );
  });

  it("audits merge and unmerge with the pointer on both sides", async () => {
    const { loser, survivor } = await pair("Quebec Quarry");
    await merges.merge({
      counterpartyId: loser.id,
      survivorId: survivor.id,
      reason: "confirmed by phone",
      actorUserId: actorId,
    });
    const merged = (await auditEventsFor(scratch, "counterparty.merged")).find(
      (row) => row.resourceId === loser.id,
    );
    expect(merged?.before).toMatchObject({ mergedIntoCounterpartyId: null });
    expect(merged?.after).toMatchObject({
      mergedIntoCounterpartyId: survivor.id,
    });
    expect(merged?.metadata).toMatchObject({
      reason: "confirmed by phone",
      loserReferenceCode: loser.referenceCode,
      survivorReferenceCode: survivor.referenceCode,
    });

    await merges.unmerge({ counterpartyId: loser.id, actorUserId: actorId });
    const unmerged = (
      await auditEventsFor(scratch, "counterparty.unmerged")
    ).find((row) => row.resourceId === loser.id);
    expect(unmerged?.before).toMatchObject({
      mergedIntoCounterpartyId: survivor.id,
    });
    expect(unmerged?.after).toMatchObject({ mergedIntoCounterpartyId: null });
  });

  it("reports nothing pointing at a merged row, because nothing may", async () => {
    expect(await merges.referencesToMergedRows()).toEqual([]);
  });
});
