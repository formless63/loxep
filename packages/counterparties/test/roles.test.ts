/**
 * Roles: the relationship row, the nullable entity, and the uniqueness that
 * makes the null safe.
 *
 * The design's second OWNER-REVIEW-CRITICAL question is whether the entity may
 * be null; the answer implemented here is yes, and the test that earns it is
 * the one asserting a party cannot hold two installation-wide `customer` rows —
 * which is only true because the unique is `NULLS NOT DISTINCT`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CounterpartyNotFoundError,
  CounterpartyValidationError,
  createContactsService,
  createCounterpartiesService,
  createRolesService,
} from "../src/index.ts";
import type {
  ContactsService,
  CounterpartiesService,
  RolesService,
} from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedEntity,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("counterparty entity roles", () => {
  let scratch: ScratchDb;
  let parties: CounterpartiesService;
  let contacts: ContactsService;
  let roles: RolesService;
  let llcId: string;
  let personalId: string;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_cp_roles");
    parties = createCounterpartiesService({ db: scratch.handle.db });
    contacts = createContactsService({ db: scratch.handle.db });
    roles = createRolesService({ db: scratch.handle.db });
    llcId = await seedEntity(scratch, "Loxep LLC");
    personalId = await seedEntity(scratch, "Personal", "individual");
    actorId = await seedUser(scratch, "roles_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function party(displayName: string) {
    return parties.create({ kind: "organization", displayName });
  }

  describe("one party, many relationships", () => {
    it("holds customer AND vendor at once — the estate-sale dealer case", async () => {
      const dealer = await party("Estate Sale Dealer");
      await roles.grant({
        counterpartyId: dealer.id,
        economicEntityId: llcId,
        role: "vendor",
      });
      await roles.grant({
        counterpartyId: dealer.id,
        economicEntityId: llcId,
        role: "customer",
      });
      const held = await roles.listForCounterparty(dealer.id);
      expect(held.map((row) => row.role).sort()).toEqual([
        "customer",
        "vendor",
      ]);
    });

    it("holds the same role against two different entities, with different terms", async () => {
      const client = await party("Two Sided Client");
      await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        paymentTermsDays: 30,
      });
      await roles.grant({
        counterpartyId: client.id,
        economicEntityId: personalId,
        role: "customer",
        paymentTermsDays: 0,
      });
      const held = await roles.listForCounterparty(client.id);
      const byEntity = new Map(
        held.map((row) => [row.economicEntityId, row.paymentTermsDays]),
      );
      // Net-30 with the LLC and cash with the personal side — representable
      // only because terms live on the relationship.
      expect(byEntity.get(llcId)).toBe(30);
      expect(byEntity.get(personalId)).toBe(0);
    });
  });

  describe("the nullable entity and its uniqueness", () => {
    it("records an installation-wide relationship when no entity is named", async () => {
      const early = await party("Unattributed Era Customer");
      const granted = await roles.grant({
        counterpartyId: early.id,
        role: "customer",
      });
      expect(granted.economicEntityId).toBeNull();
    });

    it("refuses TWO installation-wide customer rows for one party", async () => {
      // The whole point of NULLS NOT DISTINCT. The service upserts, so the
      // second grant updates rather than duplicating — and a direct insert
      // (schema.test.ts) proves the constraint underneath.
      const early = await party("Single Wide Row");
      const first = await roles.grant({
        counterpartyId: early.id,
        role: "customer",
        paymentTermsDays: 14,
      });
      const second = await roles.grant({
        counterpartyId: early.id,
        role: "customer",
        paymentTermsDays: 45,
      });
      expect(second.id).toBe(first.id);
      expect(second.paymentTermsDays).toBe(45);
      expect((await roles.listForCounterparty(early.id)).length).toBe(1);
    });

    it("keeps the installation-wide row distinct from an entity-scoped one", async () => {
      const both = await party("Wide And Scoped");
      const wide = await roles.grant({
        counterpartyId: both.id,
        role: "customer",
      });
      const scoped = await roles.grant({
        counterpartyId: both.id,
        economicEntityId: llcId,
        role: "customer",
      });
      expect(wide.id).not.toBe(scoped.id);
      expect((await roles.listForCounterparty(both.id)).length).toBe(2);
    });

    it("treats an explicit null the same as an omitted entity", async () => {
      const party1 = await party("Explicit Null Entity");
      const omitted = await roles.grant({
        counterpartyId: party1.id,
        role: "vendor",
      });
      const explicit = await roles.grant({
        counterpartyId: party1.id,
        economicEntityId: null,
        role: "vendor",
      });
      expect(explicit.id).toBe(omitted.id);
    });
  });

  describe("grant as an idempotent upsert", () => {
    it("updates terms in place rather than accumulating rows", async () => {
      const client = await party("Terms Change");
      await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        paymentTermsDays: 30,
        taxTreatment: "standard",
      });
      const updated = await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        paymentTermsDays: 60,
        taxTreatment: "reverse_charge",
        defaultCurrency: "eur",
      });
      expect(updated.paymentTermsDays).toBe(60);
      expect(updated.taxTreatment).toBe("reverse_charge");
      expect(updated.defaultCurrency).toBe("EUR");
      expect((await roles.listForCounterparty(client.id)).length).toBe(1);
    });

    it("attaches a billing contact", async () => {
      const client = await party("Has Billing Contact");
      const contact = await contacts.addContact({
        counterpartyId: client.id,
        displayName: "Accounts Payable",
      });
      const granted = await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        billingContactId: contact.id,
      });
      expect(granted.billingContactId).toBe(contact.id);
    });

    it("records descriptive dates without effective-dating anything", async () => {
      const client = await party("Dated Relationship");
      const granted = await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        sinceOn: "2026-01-01",
        untilOn: "2026-12-31",
      });
      expect(granted.sinceOn).toBe("2026-01-01");
      expect(granted.untilOn).toBe("2026-12-31");
      // No exclusion constraint: an overlapping row for another role is fine,
      // because nothing ROUTES on a role.
      await expect(
        roles.grant({
          counterpartyId: client.id,
          economicEntityId: llcId,
          role: "payer",
          sinceOn: "2026-06-01",
          untilOn: "2027-06-01",
        }),
      ).resolves.toBeDefined();
    });

    it("rejects an inverted date range and a negative term", async () => {
      const client = await party("Bad Inputs");
      await expect(
        roles.grant({
          counterpartyId: client.id,
          role: "customer",
          sinceOn: "2026-06-01",
          untilOn: "2026-05-01",
        }),
      ).rejects.toThrow(CounterpartyValidationError);
      await expect(
        roles.grant({
          counterpartyId: client.id,
          role: "customer",
          paymentTermsDays: -1,
        }),
      ).rejects.toThrow(CounterpartyValidationError);
    });

    it("rejects a role outside the closed set", async () => {
      const client = await party("Typo Role");
      await expect(
        roles.grant({
          counterpartyId: client.id,
          // @ts-expect-error a typo must not create an uninvoiceable party
          role: "Customer",
        }),
      ).rejects.toThrow(CounterpartyValidationError);
    });
  });

  describe("listByEntityRole", () => {
    it("returns an entity's customers plus the installation-wide ones", async () => {
      const scoped = await party("Scoped Customer");
      const wide = await party("Wide Customer");
      const other = await party("Other Entity Customer");
      await roles.grant({
        counterpartyId: scoped.id,
        economicEntityId: llcId,
        role: "customer",
      });
      await roles.grant({ counterpartyId: wide.id, role: "customer" });
      await roles.grant({
        counterpartyId: other.id,
        economicEntityId: personalId,
        role: "customer",
      });

      const ids = (
        await roles.listByEntityRole({
          role: "customer",
          economicEntityId: llcId,
        })
      ).map((row) => row.counterpartyId);
      expect(ids).toEqual(expect.arrayContaining([scoped.id, wide.id]));
      expect(ids).not.toContain(other.id);
    });

    it("can exclude the installation-wide rows", async () => {
      const wide = await party("Excluded Wide Customer");
      await roles.grant({ counterpartyId: wide.id, role: "consignor" });
      const ids = (
        await roles.listByEntityRole({
          role: "consignor",
          economicEntityId: llcId,
          includeInstallationWide: false,
        })
      ).map((row) => row.counterpartyId);
      expect(ids).not.toContain(wide.id);
    });

    it("returns only installation-wide rows when no entity is named", async () => {
      const wide = await party("Only Wide Partner");
      const scoped = await party("Only Scoped Partner");
      await roles.grant({ counterpartyId: wide.id, role: "partner" });
      await roles.grant({
        counterpartyId: scoped.id,
        economicEntityId: llcId,
        role: "partner",
      });
      const ids = (await roles.listByEntityRole({ role: "partner" })).map(
        (row) => row.counterpartyId,
      );
      expect(ids).toContain(wide.id);
      expect(ids).not.toContain(scoped.id);
    });

    it("shows active roles by default and hides revoked ones", async () => {
      const client = await party("Revoked Customer");
      const granted = await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "subcontractor",
      });
      await roles.revoke({ roleId: granted.id, actorUserId: actorId });
      const active = await roles.listByEntityRole({
        role: "subcontractor",
        economicEntityId: llcId,
      });
      expect(active.map((row) => row.counterpartyId)).not.toContain(client.id);
      const inactive = await roles.listByEntityRole({
        role: "subcontractor",
        economicEntityId: llcId,
        statuses: ["inactive"],
      });
      expect(inactive.map((row) => row.counterpartyId)).toContain(client.id);
    });

    it("carries the terms the billing path will read", async () => {
      const client = await party("Terms Carrier");
      await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "payer",
        paymentTermsDays: 21,
        defaultCurrency: "USD",
        taxTreatment: "exempt",
      });
      const row = (
        await roles.listByEntityRole({
          role: "payer",
          economicEntityId: llcId,
        })
      ).find((candidate) => candidate.counterpartyId === client.id);
      expect(row).toMatchObject({
        paymentTermsDays: 21,
        defaultCurrency: "USD",
        taxTreatment: "exempt",
      });
    });
  });

  describe("revoke, remove, and the audit trail", () => {
    it("revoke deactivates without deleting", async () => {
      const client = await party("Deactivated");
      const granted = await roles.grant({
        counterpartyId: client.id,
        role: "payee",
      });
      const revoked = await roles.revoke({ roleId: granted.id });
      expect(revoked.status).toBe("inactive");
      expect((await roles.listForCounterparty(client.id)).length).toBe(1);
    });

    it("remove deletes the relationship row", async () => {
      const client = await party("Removed Role");
      const granted = await roles.grant({
        counterpartyId: client.id,
        role: "other",
      });
      await roles.remove({ roleId: granted.id });
      expect((await roles.listForCounterparty(client.id)).length).toBe(0);
      await expect(roles.revoke({ roleId: granted.id })).rejects.toThrow(
        CounterpartyNotFoundError,
      );
    });

    it("audits grant, update, revoke, and remove", async () => {
      const client = await party("Fully Audited");
      const granted = await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        createdByUserId: actorId,
      });
      await roles.grant({
        counterpartyId: client.id,
        economicEntityId: llcId,
        role: "customer",
        paymentTermsDays: 7,
        createdByUserId: actorId,
      });
      await roles.revoke({ roleId: granted.id, actorUserId: actorId });
      await roles.remove({ roleId: granted.id, actorUserId: actorId });

      for (const action of [
        "counterparty.role_granted",
        "counterparty.role_updated",
        "counterparty.role_revoked",
        "counterparty.role_removed",
      ]) {
        const events = await auditEventsFor(scratch, action);
        expect(events.some((row) => row.resourceId === client.id)).toBe(true);
      }
    });
  });
});
