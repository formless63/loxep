/**
 * The counterparty record: creation, reference codes, normalized names, the
 * boundary refusals, the declared mirror, and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CounterpartyBoundaryError,
  CounterpartyNotFoundError,
  CounterpartyValidationError,
  createContactsService,
  createCounterpartiesService,
} from "../src/index.ts";
import type {
  ContactsService,
  CounterpartiesService,
} from "../src/index.ts";
import {
  auditEventsFor,
  createMigratedScratchDb,
  seedEntity,
  seedUser,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("counterparties service", () => {
  let scratch: ScratchDb;
  let parties: CounterpartiesService;
  let contacts: ContactsService;
  let entityId: string;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_cp_service");
    parties = createCounterpartiesService({ db: scratch.handle.db });
    contacts = createContactsService({ db: scratch.handle.db });
    entityId = await seedEntity(scratch, "Loxep LLC");
    actorId = await seedUser(scratch, "cp_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  describe("creation", () => {
    it("generates CP-<year>-NNNN and increments", async () => {
      const first = await parties.create({
        kind: "organization",
        displayName: "Alpha Ltd",
      });
      const second = await parties.create({
        kind: "organization",
        displayName: "Beta Ltd",
      });
      expect(first.referenceCode).toMatch(/^CP-\d{4}-\d{4}$/);
      expect(Number(second.referenceCode.slice(-4))).toBe(
        Number(first.referenceCode.slice(-4)) + 1,
      );
    });

    it("stores a normalized name derived from the LEGAL name when present", async () => {
      const withLegal = await parties.create({
        kind: "organization",
        displayName: "Acme",
        legalName: "The Acme Roofing Co., Inc.",
      });
      expect(withLegal.normalizedName).toBe("acme roofing co inc");

      const withoutLegal = await parties.create({
        kind: "organization",
        displayName: "The Acme Roofing Company Incorporated",
      });
      // The two spellings land in the same candidate group.
      expect(withoutLegal.normalizedName).toBe(withLegal.normalizedName);
    });

    it("uppercases the default currency preference", async () => {
      const party = await parties.create({
        kind: "person",
        displayName: "Jane Doe",
        defaultCurrency: "gbp",
      });
      expect(party.defaultCurrency).toBe("GBP");
    });

    it("defaults to active and accepts every documented status", async () => {
      const active = await parties.create({
        kind: "person",
        displayName: "Default Status",
      });
      expect(active.status).toBe("active");
      for (const status of ["active", "inactive", "archived"] as const) {
        await expect(
          parties.create({
            kind: "person",
            displayName: `Status ${status}`,
            status,
          }),
        ).resolves.toMatchObject({ status });
      }
    });

    it("has no is_customer / is_vendor concept to set", async () => {
      await expect(
        parties.create({
          kind: "organization",
          displayName: "Flagged",
          // @ts-expect-error there is no such field, by design
          isCustomer: true,
        }),
      ).rejects.toThrow(CounterpartyValidationError);
    });

    it("rejects `customer` as a kind — role is not a property of the party", async () => {
      await expect(
        parties.create({
          // @ts-expect-error the kind union has exactly two members
          kind: "customer",
          displayName: "Wrong Kind",
        }),
      ).rejects.toThrow(CounterpartyValidationError);
    });
  });

  describe("the boundary", () => {
    it("REFUSES a tax identifier on a person, with a reason not a constraint name", async () => {
      await expect(
        parties.create({
          kind: "person",
          displayName: "Jane Doe",
          taxIdentifier: "123-45-6789",
          taxIdentifierKind: "other",
        }),
      ).rejects.toThrow(CounterpartyBoundaryError);
      await expect(
        parties.create({
          kind: "person",
          displayName: "Jane Doe",
          taxIdentifier: "123-45-6789",
          taxIdentifierKind: "other",
        }),
      ).rejects.toThrow(/permanently, not pending a feature/);
    });

    it("refuses to add one to a person by update either", async () => {
      const person = await parties.create({
        kind: "person",
        displayName: "Later Attempt",
      });
      await expect(
        parties.update({
          counterpartyId: person.id,
          taxIdentifier: "999",
          taxIdentifierKind: "ein",
        }),
      ).rejects.toThrow(CounterpartyBoundaryError);
    });

    it("accepts a tax identifier on an organization", async () => {
      const org = await parties.create({
        kind: "organization",
        displayName: "VAT Registered Ltd",
        taxIdentifier: "GB123456789",
        taxIdentifierKind: "vat",
      });
      expect(org.taxIdentifier).toBe("GB123456789");
    });

    it("requires the identifier and its kind together", async () => {
      await expect(
        parties.create({
          kind: "organization",
          displayName: "Half Recorded",
          taxIdentifier: "GB1",
        }),
      ).rejects.toThrow(CounterpartyValidationError);
    });
  });

  describe("the declared mirror", () => {
    it("declares, reports, and withdraws", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Sibling DBA",
      });
      const declared = await parties.declareMirror({
        counterpartyId: party.id,
        economicEntityId: entityId,
        actorUserId: actorId,
      });
      expect(declared.mirrorsEconomicEntityId).toBe(entityId);

      const mirrors = await parties.mirrors();
      expect(mirrors).toContainEqual(
        expect.objectContaining({
          counterpartyId: party.id,
          economicEntityId: entityId,
          economicEntityName: "Loxep LLC",
        }),
      );

      const withdrawn = await parties.declareMirror({
        counterpartyId: party.id,
        economicEntityId: null,
      });
      expect(withdrawn.mirrorsEconomicEntityId).toBeNull();
      expect(
        (await parties.mirrors()).map((row) => row.counterpartyId),
      ).not.toContain(party.id);
    });

    it("refuses to mirror an entity that does not exist", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Bad Mirror",
      });
      await expect(
        parties.declareMirror({
          counterpartyId: party.id,
          economicEntityId: "00000000-0000-4000-8000-000000000000",
        }),
      ).rejects.toThrow(CounterpartyBoundaryError);
    });

    it("audits the declaration as its own act", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Audited Mirror",
      });
      await parties.declareMirror({
        counterpartyId: party.id,
        economicEntityId: entityId,
        actorUserId: actorId,
      });
      const events = await auditEventsFor(
        scratch,
        "counterparty.mirror_declared",
      );
      const event = events.find((row) => row.resourceId === party.id);
      expect(event?.after).toMatchObject({
        mirrorsEconomicEntityId: entityId,
      });
      expect(String((event?.metadata as { note?: string }).note)).toContain(
        "remains an outside record",
      );
    });
  });

  describe("update", () => {
    it("recomputes the normalized name whenever a name changes", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Original Name",
      });
      const renamed = await parties.update({
        counterpartyId: party.id,
        displayName: "Renamed Roofing Limited",
      });
      expect(renamed.normalizedName).toBe("renamed roofing ltd");

      const relegalled = await parties.update({
        counterpartyId: party.id,
        legalName: "Renamed Roofing Company",
      });
      // The legal name wins once it exists.
      expect(relegalled.normalizedName).toBe("renamed roofing co");
    });

    it("clears a nullable field when passed null", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Nullable",
        notes: "note",
        defaultCurrency: "USD",
      });
      const cleared = await parties.update({
        counterpartyId: party.id,
        notes: null,
        defaultCurrency: null,
      });
      expect(cleared.notes).toBeNull();
      expect(cleared.defaultCurrency).toBeNull();
    });

    it("raises for an unknown id", async () => {
      await expect(
        parties.update({
          counterpartyId: "00000000-0000-4000-8000-000000000000",
          displayName: "Ghost",
        }),
      ).rejects.toThrow(CounterpartyNotFoundError);
    });
  });

  describe("lookup and listing", () => {
    it("finds by reference code", async () => {
      const party = await parties.create({
        kind: "person",
        displayName: "By Code",
      });
      const found = await parties.getByReferenceCode(party.referenceCode);
      expect(found.id).toBe(party.id);
      await expect(parties.getByReferenceCode("CP-NOPE")).rejects.toThrow(
        CounterpartyNotFoundError,
      );
    });

    it("searches through the SAME normalization the stored name used", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Zulu Zinc Limited",
      });
      // The query spelling differs from the stored spelling in case, suffix,
      // and punctuation, and still matches.
      const found = await parties.list({ search: "zulu zinc ltd." });
      expect(found.map((row) => row.id)).toContain(party.id);
    });

    it("filters by kind and status, and honours a limit", async () => {
      const person = await parties.create({
        kind: "person",
        displayName: "Filter Person",
      });
      const org = await parties.create({
        kind: "organization",
        displayName: "Filter Org",
        status: "inactive",
      });
      const people = await parties.list({ search: "Filter", kind: "person" });
      expect(people.map((row) => row.id)).toEqual([person.id]);
      const inactive = await parties.list({
        search: "Filter",
        statuses: ["inactive"],
      });
      expect(inactive.map((row) => row.id)).toEqual([org.id]);
      expect((await parties.list({ limit: 1 })).length).toBe(1);
    });
  });

  describe("contacts and channels", () => {
    it("keeps one primary contact per party, promoting and demoting together", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Primary Contacts",
      });
      const jane = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Jane",
        isPrimary: true,
      });
      const bob = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Bob",
        isPrimary: true,
      });
      expect(bob.isPrimary).toBe(true);
      const listed = await contacts.listContacts(party.id);
      expect(listed.filter((row) => row.isPrimary).map((row) => row.id)).toEqual(
        [bob.id],
      );

      const promoted = await contacts.setPrimaryContact({ contactId: jane.id });
      expect(promoted.isPrimary).toBe(true);
      const after = await contacts.listContacts(party.id);
      expect(after.filter((row) => row.isPrimary).length).toBe(1);
    });

    it("carries optional given/family name (migration 0023, loxep-cd3.1), independent of display_name", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Split Name Owner",
      });
      const named = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Jane Doe",
        givenName: "Jane",
        familyName: "Doe",
      });
      expect(named.givenName).toBe("Jane");
      expect(named.familyName).toBe("Doe");

      // A contact may legitimately be "Accounts Payable" rather than a
      // person — given/family name stay optional and null by default.
      const roleTitleOnly = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Accounts Payable",
      });
      expect(roleTitleOnly.givenName).toBeNull();
      expect(roleTitleOnly.familyName).toBeNull();

      const updated = await contacts.updateContact({
        contactId: roleTitleOnly.id,
        givenName: "Pat",
      });
      expect(updated.givenName).toBe("Pat");
      expect(updated.displayName).toBe("Accounts Payable");

      const cleared = await contacts.updateContact({
        contactId: roleTitleOnly.id,
        givenName: null,
      });
      expect(cleared.givenName).toBeNull();
    });

    it("normalizes a channel value on the way in", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Channel Owner",
      });
      const channel = await contacts.addChannel({
        counterpartyId: party.id,
        channelKind: "email",
        value: "  Billing@Acme.TEST ",
      });
      expect(channel.value).toBe("Billing@Acme.TEST");
      expect(channel.normalizedValue).toBe("billing@acme.test");
    });

    it("refuses a channel owned by both a party and a contact, or by neither", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Ambiguous Owner",
      });
      const contact = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Jane",
      });
      await expect(
        contacts.addChannel({
          counterpartyId: party.id,
          counterpartyContactId: contact.id,
          channelKind: "email",
          value: "a@b.test",
        }),
      ).rejects.toThrow(/never both and never neither/);
      await expect(
        contacts.addChannel({ channelKind: "email", value: "a@b.test" }),
      ).rejects.toThrow(/never both and never neither/);
    });

    it("keeps one primary channel per owner per kind", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Primary Channels",
      });
      await contacts.addChannel({
        counterpartyId: party.id,
        channelKind: "email",
        value: "first@acme.test",
        isPrimary: true,
      });
      const second = await contacts.addChannel({
        counterpartyId: party.id,
        channelKind: "email",
        value: "second@acme.test",
        isPrimary: true,
      });
      const channels = await contacts.listChannels(party.id);
      const primaries = channels.filter(
        (row) => row.channelKind === "email" && row.isPrimary,
      );
      expect(primaries.map((row) => row.id)).toEqual([second.id]);
    });

    it("lists a party's own channels alongside its contacts'", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Both Levels",
      });
      const contact = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Jane",
      });
      await contacts.addChannel({
        counterpartyId: party.id,
        channelKind: "email",
        value: "billing@both.test",
      });
      await contacts.addChannel({
        counterpartyContactId: contact.id,
        channelKind: "mobile",
        value: "+1 555 0101",
      });
      const channels = await contacts.listChannels(party.id);
      expect(channels.length).toBe(2);
      expect(channels.map((row) => row.channelKind).sort()).toEqual([
        "email",
        "mobile",
      ]);
    });

    it("records an opt-out as a fact and never deletes the row", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Opted Out",
      });
      const channel = await contacts.addChannel({
        counterpartyId: party.id,
        channelKind: "email",
        value: "stop@acme.test",
      });
      const opted = await contacts.optOut({ channelId: channel.id });
      expect(opted.optedOutAt).toBeInstanceOf(Date);
      // Idempotent: a second opt-out keeps the ORIGINAL timestamp.
      const again = await contacts.optOut({ channelId: channel.id });
      expect(again.optedOutAt?.getTime()).toBe(opted.optedOutAt?.getTime());
      expect((await contacts.listChannels(party.id)).length).toBe(1);
    });

    it("never puts a channel VALUE into an audit snapshot", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Quiet Audit",
      });
      await contacts.addChannel({
        counterpartyId: party.id,
        channelKind: "email",
        value: "secret.person@example.test",
      });
      const events = await auditEventsFor(scratch, "counterparty.channel_added");
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("secret.person@example.test");
      expect(serialized).toContain("channelKind");
    });

    it("removing a contact clears it from any role that named it for billing", async () => {
      const party = await parties.create({
        kind: "organization",
        displayName: "Billing Contact Owner",
      });
      const contact = await contacts.addContact({
        counterpartyId: party.id,
        displayName: "Jane",
      });
      await scratch.handle.pool.query(
        `insert into counterparty_entity_roles
           (counterparty_id, role, billing_contact_id)
         values ($1, 'customer', $2)`,
        [party.id, contact.id],
      );
      await contacts.removeContact({ contactId: contact.id });
      const role = await scratch.handle.pool.query<{
        billing_contact_id: string | null;
      }>(
        `select billing_contact_id from counterparty_entity_roles
          where counterparty_id = $1`,
        [party.id],
      );
      expect(role.rows[0]?.billing_contact_id).toBeNull();
    });
  });

  it("audits creation and update", async () => {
    const party = await parties.create({
      kind: "organization",
      displayName: "Audited Co",
      createdByUserId: actorId,
    });
    await parties.update({
      counterpartyId: party.id,
      status: "inactive",
      actorUserId: actorId,
    });
    const created = (
      await auditEventsFor(scratch, "counterparty.created")
    ).find((row) => row.resourceId === party.id);
    expect(created?.after).toMatchObject({
      displayName: "Audited Co",
      kind: "organization",
    });
    const updated = (
      await auditEventsFor(scratch, "counterparty.updated")
    ).find((row) => row.resourceId === party.id);
    expect(updated?.before).toMatchObject({ status: "active" });
    expect(updated?.after).toMatchObject({ status: "inactive" });
  });
});
