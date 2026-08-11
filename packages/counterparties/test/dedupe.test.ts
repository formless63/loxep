/**
 * Duplicate-candidate finding.
 *
 * Half of these tests assert what the finder catches; the other half assert
 * what it deliberately does NOT catch. Both halves matter: an undocumented gap
 * looks like a bug, and the gaps are the argument for shipping no fuzzy matcher
 * — the same "ship the state, not the matcher" posture Phase 5 took for
 * reconciliation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createContactsService,
  createCounterpartiesService,
  createDedupeService,
  createMergeService,
} from "../src/index.ts";
import type {
  ContactsService,
  CounterpartiesService,
  DedupeService,
  MergeService,
} from "../src/index.ts";
import { createMigratedScratchDb } from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("duplicate candidates", () => {
  let scratch: ScratchDb;
  let parties: CounterpartiesService;
  let contacts: ContactsService;
  let dedupe: DedupeService;
  let merges: MergeService;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_cp_dedupe");
    parties = createCounterpartiesService({ db: scratch.handle.db });
    contacts = createContactsService({ db: scratch.handle.db });
    dedupe = createDedupeService({ db: scratch.handle.db });
    merges = createMergeService({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  async function org(displayName: string, legalName?: string) {
    return parties.create({
      kind: "organization",
      displayName,
      ...(legalName === undefined ? {} : { legalName }),
    });
  }

  describe("byName", () => {
    it("groups spellings the normalizer folds together", async () => {
      const first = await org("The Acme Roofing Co., Inc.");
      const second = await org("acme roofing company incorporated");
      const groups = await dedupe.byName();
      const group = groups.find(
        (candidate) => candidate.matchValue === "acme roofing co inc",
      );
      expect(group?.matchKind).toBe("normalized_name");
      expect(group?.members.map((member) => member.counterpartyId).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    it("does not group a singleton", async () => {
      await org("Utterly Unique Enterprises");
      const groups = await dedupe.byName();
      expect(
        groups.some((group) => group.matchValue.includes("utterly unique")),
      ).toBe(false);
    });

    it("does NOT group a suffix with its absence — the documented gap", async () => {
      await org("Gapcheck Roofing");
      await org("Gapcheck Roofing LLC");
      const groups = await dedupe.byName();
      expect(
        groups.some((group) => group.matchValue.startsWith("gapcheck")),
      ).toBe(false);
    });

    it("does NOT group a misspelling — the other documented gap", async () => {
      await org("Spellcheck Supplies");
      await org("Spelcheck Supplies");
      const groups = await dedupe.byName();
      expect(
        groups.some((group) => group.matchValue.includes("spellcheck")),
      ).toBe(false);
    });

    it("drops a merged row out of its group, and the group with it", async () => {
      const first = await org("Merged Away Ltd");
      const second = await org("Merged Away Limited");
      expect(
        (await dedupe.byName()).some(
          (group) => group.matchValue === "merged away ltd",
        ),
      ).toBe(true);
      await merges.merge({
        counterpartyId: first.id,
        survivorId: second.id,
      });
      // Once merged, the pair is resolved and must stop being offered.
      expect(
        (await dedupe.byName()).some(
          (group) => group.matchValue === "merged away ltd",
        ),
      ).toBe(false);
    });

    it("excludes archived rows, which are hidden from every picker", async () => {
      await parties.create({
        kind: "organization",
        displayName: "Archived Twin",
        status: "archived",
      });
      await parties.create({
        kind: "organization",
        displayName: "Archived Twin",
      });
      expect(
        (await dedupe.byName()).some(
          (group) => group.matchValue === "archived twin",
        ),
      ).toBe(false);
    });
  });

  describe("byChannel", () => {
    it("groups two parties sharing a normalized email", async () => {
      const first = await org("Channel Twin A");
      const second = await org("Channel Twin B");
      await contacts.addChannel({
        counterpartyId: first.id,
        channelKind: "email",
        value: "Shared@Twins.test",
      });
      await contacts.addChannel({
        counterpartyId: second.id,
        channelKind: "email",
        value: "  shared@twins.test ",
      });
      const groups = await dedupe.byChannel();
      const group = groups.find(
        (candidate) => candidate.matchValue === "email:shared@twins.test",
      );
      expect(group?.matchKind).toBe("contact_channel");
      expect(group?.members.length).toBe(2);
    });

    it("counts a CONTACT's channel toward that contact's counterparty", async () => {
      const first = await org("Contact Level A");
      const second = await org("Contact Level B");
      const jane = await contacts.addContact({
        counterpartyId: first.id,
        displayName: "Jane",
      });
      await contacts.addChannel({
        counterpartyContactId: jane.id,
        channelKind: "email",
        value: "jane@shared.test",
      });
      await contacts.addChannel({
        counterpartyId: second.id,
        channelKind: "email",
        value: "jane@shared.test",
      });
      const group = (await dedupe.byChannel()).find(
        (candidate) => candidate.matchValue === "email:jane@shared.test",
      );
      expect(
        group?.members.map((member) => member.counterpartyId).sort(),
      ).toEqual([first.id, second.id].sort());
    });

    it("does not group across channel kinds", async () => {
      const first = await org("Kind Split A");
      const second = await org("Kind Split B");
      await contacts.addChannel({
        counterpartyId: first.id,
        channelKind: "marketplace_handle",
        value: "5551234",
      });
      await contacts.addChannel({
        counterpartyId: second.id,
        channelKind: "phone",
        value: "5551234",
      });
      expect(
        (await dedupe.byChannel()).some((group) =>
          group.matchValue.endsWith(":5551234"),
        ),
      ).toBe(false);
    });

    it("ignores an opted-out channel — it is not a matching signal", async () => {
      const first = await org("Opted Out A");
      const second = await org("Opted Out B");
      const channel = await contacts.addChannel({
        counterpartyId: first.id,
        channelKind: "email",
        value: "quiet@optout.test",
      });
      await contacts.addChannel({
        counterpartyId: second.id,
        channelKind: "email",
        value: "quiet@optout.test",
      });
      await contacts.optOut({ channelId: channel.id });
      expect(
        (await dedupe.byChannel()).some(
          (group) => group.matchValue === "email:quiet@optout.test",
        ),
      ).toBe(false);
    });

    it("filters by channel kind on request", async () => {
      const first = await org("Kind Filter A");
      const second = await org("Kind Filter B");
      for (const partyId of [first.id, second.id]) {
        await contacts.addChannel({
          counterpartyId: partyId,
          channelKind: "website",
          value: "https://www.kindfilter.test/",
        });
      }
      expect(
        (await dedupe.byChannel({ channelKinds: ["website"] })).some(
          (group) => group.matchValue === "website:kindfilter.test",
        ),
      ).toBe(true);
      expect(
        (await dedupe.byChannel({ channelKinds: ["email"] })).some(
          (group) => group.matchValue === "website:kindfilter.test",
        ),
      ).toBe(false);
    });

    it("counts one party once even when it holds the address twice over", async () => {
      // Same normalized value on the party AND on one of its contacts must not
      // make the party look like two parties.
      const solo = await org("Self Duplicate");
      const jane = await contacts.addContact({
        counterpartyId: solo.id,
        displayName: "Jane",
      });
      await contacts.addChannel({
        counterpartyId: solo.id,
        channelKind: "email",
        value: "solo@self.test",
      });
      await contacts.addChannel({
        counterpartyContactId: jane.id,
        channelKind: "email",
        value: "solo@self.test",
      });
      expect(
        (await dedupe.byChannel()).some(
          (group) => group.matchValue === "email:solo@self.test",
        ),
      ).toBe(false);
    });
  });

  it("candidates() returns both finders and merges nothing", async () => {
    const before = await scratch.handle.pool.query<{ count: string }>(
      `select count(*)::text as count from counterparties
        where merged_into_counterparty_id is not null`,
    );
    const groups = await dedupe.candidates();
    expect(
      new Set(groups.map((group) => group.matchKind)),
    ).toEqual(new Set(["normalized_name", "contact_channel"]));
    const after = await scratch.handle.pool.query<{ count: string }>(
      `select count(*)::text as count from counterparties
        where merged_into_counterparty_id is not null`,
    );
    // A finder that merged anything would be the single worst bug in this
    // package: a human merges, always.
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("orders members oldest-first so a survivor suggestion is stable", async () => {
    const first = await org("Order Check Ltd");
    const second = await org("Order Check Limited");
    const group = (await dedupe.byName()).find(
      (candidate) => candidate.matchValue === "order check ltd",
    );
    expect(group?.members.map((member) => member.counterpartyId)).toEqual([
      first.id,
      second.id,
    ]);
    expect(group?.members[0]?.createdAt).toBeInstanceOf(Date);
  });
});
