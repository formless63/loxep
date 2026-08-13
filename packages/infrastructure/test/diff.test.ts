/**
 * The diff engine, exhaustively. Pure: no database, no network, no clock.
 *
 * The four outcomes and their inverses, the record-identity rule, TTL and
 * proxy comparison, and the two operations the reconciler may NEVER derive:
 * rewriting a `manual` record and deleting an `unexpected` one.
 */
import { describe, expect, it } from "vitest";
import {
  applyOperationsFor,
  assertNoUnexpectedDeletions,
  diffDnsRecords,
} from "../src/index.ts";
import type { IntentRecord } from "../src/index.ts";
import { observed } from "./helpers.ts";

function intent(
  overrides: Partial<IntentRecord> & { id: string },
): IntentRecord {
  return {
    type: "A",
    name: "@",
    content: "203.0.113.10",
    ttlSeconds: null,
    priority: null,
    proxied: false,
    owner: "apex",
    externalRecordId: null,
    ...overrides,
  };
}

describe("diffDnsRecords — the four outcomes", () => {
  it("reports no-op when both sides agree exactly", () => {
    const diff = diffDnsRecords(
      [intent({ id: "i1" })],
      [observed({ externalRecordId: "r1" })],
    );
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.missing).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
    expect(diff.unexpected).toHaveLength(0);
  });

  it("reports 'missing' when intent has a record the provider does not", () => {
    const diff = diffDnsRecords([intent({ id: "i1" })], []);
    expect(diff.missing).toHaveLength(1);
    expect(diff.missing[0]?.intent.id).toBe("i1");
  });

  it("reports 'unexpected' when the provider has a record intent never described", () => {
    // The single most important drift class: how a hand-edit in a provider
    // dashboard becomes visible.
    const diff = diffDnsRecords(
      [],
      [observed({ externalRecordId: "r1", type: "TXT", name: "_acme-challenge" })],
    );
    expect(diff.unexpected).toHaveLength(1);
    expect(diff.unexpected[0]?.observed.externalRecordId).toBe("r1");
  });

  it("reports 'modified' — not missing+unexpected — when content changed", () => {
    const diff = diffDnsRecords(
      [intent({ id: "i1", content: "203.0.113.10" })],
      [observed({ externalRecordId: "r1", content: "203.0.113.99" })],
    );
    expect(diff.modified).toHaveLength(1);
    expect(diff.missing).toHaveLength(0);
    expect(diff.unexpected).toHaveLength(0);
    expect(diff.modified[0]?.changed).toEqual(["content"]);
  });
});

describe("the comparable attributes", () => {
  it("detects a proxied-flag change on otherwise identical records", () => {
    const diff = diffDnsRecords(
      [intent({ id: "i1", proxied: true })],
      [observed({ externalRecordId: "r1", proxied: false })],
    );
    expect(diff.modified[0]?.changed).toEqual(["proxied"]);
  });

  it("treats null TTL on both sides as equal — the provider default", () => {
    // The adapter has already translated its sentinel back to null, which is
    // the entire reason that translation lives at the boundary.
    const diff = diffDnsRecords(
      [intent({ id: "i1", ttlSeconds: null })],
      [observed({ externalRecordId: "r1", ttlSeconds: null })],
    );
    expect(diff.unchanged).toHaveLength(1);
  });

  it("detects a TTL change, including automatic-versus-explicit", () => {
    expect(
      diffDnsRecords(
        [intent({ id: "i1", ttlSeconds: 300 })],
        [observed({ externalRecordId: "r1", ttlSeconds: 600 })],
      ).modified[0]?.changed,
    ).toEqual(["ttlSeconds"]);

    expect(
      diffDnsRecords(
        [intent({ id: "i1", ttlSeconds: null })],
        [observed({ externalRecordId: "r1", ttlSeconds: 300 })],
      ).modified[0]?.changed,
    ).toEqual(["ttlSeconds"]);
  });

  it("detects a priority change and treats undefined as null", () => {
    expect(
      diffDnsRecords(
        [intent({ id: "i1", type: "MX", content: "mx.test", priority: 10 })],
        [
          observed({
            externalRecordId: "r1",
            type: "MX",
            content: "mx.test",
            priority: 20,
          }),
        ],
      ).modified[0]?.changed,
    ).toEqual(["priority"]);
  });

  it("reports every changed attribute, not just the first", () => {
    const diff = diffDnsRecords(
      [intent({ id: "i1", content: "a", proxied: true, ttlSeconds: 300 })],
      [
        observed({
          externalRecordId: "r1",
          content: "b",
          proxied: false,
          ttlSeconds: 600,
        }),
      ],
    );
    expect(diff.modified[0]?.changed).toEqual([
      "content",
      "proxied",
      "ttlSeconds",
    ]);
  });
});

describe("record identity — pairing on (type, name), matching content first", () => {
  it("does not confuse two records that differ only by type", () => {
    const diff = diffDnsRecords(
      [
        intent({ id: "i1", type: "A", content: "203.0.113.10" }),
        intent({ id: "i2", type: "AAAA", content: "2001:db8::10" }),
      ],
      [
        observed({ externalRecordId: "r1", type: "A", content: "203.0.113.10" }),
        observed({
          externalRecordId: "r2",
          type: "AAAA",
          content: "2001:db8::10",
        }),
      ],
    );
    expect(diff.unchanged).toHaveLength(2);
  });

  it("keeps an unchanged member of a MULTI-VALUED set out of the drift report", () => {
    // The failure this prevents: a sweep reporting drift on a correct zone
    // forever, which is what makes people stop reading drift reports.
    const diff = diffDnsRecords(
      [
        intent({ id: "i1", type: "MX", content: "mx1.test", priority: 10 }),
        intent({ id: "i2", type: "MX", content: "mx2.test", priority: 20 }),
      ],
      [
        // Deliberately in the OPPOSITE order to intent.
        observed({
          externalRecordId: "r2",
          type: "MX",
          content: "mx2.test",
          priority: 20,
        }),
        observed({
          externalRecordId: "r1",
          type: "MX",
          content: "mx1.test",
          priority: 10,
        }),
      ],
    );
    expect(diff.unchanged).toHaveLength(2);
    expect(diff.modified).toHaveLength(0);
  });

  it("reports only the changed member of a multi-valued set", () => {
    const diff = diffDnsRecords(
      [
        intent({ id: "i1", type: "TXT", content: "v=spf1 -all" }),
        intent({ id: "i2", type: "TXT", content: "keep-me" }),
      ],
      [
        observed({ externalRecordId: "r1", type: "TXT", content: "keep-me" }),
        observed({
          externalRecordId: "r2",
          type: "TXT",
          content: "v=spf1 include:old -all",
        }),
      ],
    );
    expect(diff.unchanged.map((entry) => entry.intent.id)).toEqual(["i2"]);
    expect(diff.modified.map((entry) => entry.intent.id)).toEqual(["i1"]);
    expect(diff.unexpected).toHaveLength(0);
  });

  it("reports the surplus provider values as unexpected when it has more", () => {
    const diff = diffDnsRecords(
      [intent({ id: "i1", type: "TXT", content: "a" })],
      [
        observed({ externalRecordId: "r1", type: "TXT", content: "a" }),
        observed({ externalRecordId: "r2", type: "TXT", content: "b" }),
      ],
    );
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.unexpected.map((entry) => entry.observed.externalRecordId)).toEqual([
      "r2",
    ]);
  });

  it("reports the surplus intent values as missing when intent has more", () => {
    const diff = diffDnsRecords(
      [
        intent({ id: "i1", type: "TXT", content: "a" }),
        intent({ id: "i2", type: "TXT", content: "b" }),
      ],
      [observed({ externalRecordId: "r1", type: "TXT", content: "a" })],
    );
    expect(diff.unchanged).toHaveLength(1);
    expect(diff.missing.map((entry) => entry.intent.id)).toEqual(["i2"]);
  });

  it("is empty in both directions for empty inputs", () => {
    const diff = diffDnsRecords([], []);
    expect(diff.entries).toHaveLength(0);
  });

  it("collects every entry into a stable combined list", () => {
    const diff = diffDnsRecords(
      [
        intent({ id: "i1", name: "a" }),
        intent({ id: "i2", name: "b", content: "old" }),
        intent({ id: "i3", name: "c" }),
      ],
      [
        observed({ externalRecordId: "r2", name: "b", content: "new" }),
        observed({ externalRecordId: "r3", name: "c" }),
        observed({ externalRecordId: "r4", name: "d" }),
      ],
    );
    expect(diff.entries.map((entry) => entry.kind)).toEqual([
      "missing",
      "modified",
      "unexpected",
      "unchanged",
    ]);
  });
});

describe("applyOperationsFor — what apply may and may not do", () => {
  it("creates for a missing record and updates for a modified one", () => {
    const diff = diffDnsRecords(
      [
        intent({ id: "i1", name: "a" }),
        intent({ id: "i2", name: "b", content: "want" }),
      ],
      [observed({ externalRecordId: "r2", name: "b", content: "have" })],
    );
    const operations = applyOperationsFor(diff);
    expect(operations).toEqual([
      {
        kind: "create",
        record: {
          type: "A",
          name: "a",
          content: "203.0.113.10",
          ttlSeconds: null,
          priority: null,
          proxied: false,
        },
      },
      {
        kind: "update",
        externalRecordId: "r2",
        record: {
          type: "A",
          name: "b",
          content: "want",
          ttlSeconds: null,
          priority: null,
          proxied: false,
        },
      },
    ]);
  });

  it("NEVER rewrites a manual record, even when it drifted", () => {
    // "A reconciler that deletes it on the next sweep is a reconciler nobody
    // will run." Comparison is free; only rewriting is dangerous.
    const diff = diffDnsRecords(
      [intent({ id: "i1", owner: "manual", content: "authored" })],
      [observed({ externalRecordId: "r1", content: "hand-edited" })],
    );
    expect(diff.modified).toHaveLength(1);
    expect(applyOperationsFor(diff)).toEqual([]);
  });

  it("never creates a manual record either", () => {
    const diff = diffDnsRecords([intent({ id: "i1", owner: "manual" })], []);
    expect(diff.missing).toHaveLength(1);
    expect(applyOperationsFor(diff)).toEqual([]);
  });

  it("NEVER deletes an unexpected record, in any mode (open question 3)", () => {
    const diff = diffDnsRecords(
      [],
      [
        observed({ externalRecordId: "r1", name: "surprise" }),
        observed({ externalRecordId: "r2", name: "another" }),
      ],
    );
    expect(diff.unexpected).toHaveLength(2);
    expect(applyOperationsFor(diff)).toEqual([]);
  });

  it("deletes ONLY the tombstones the caller paired with an observed record", () => {
    const diff = diffDnsRecords([], [observed({ externalRecordId: "r1" })]);
    const tombstone = {
      intent: intent({ id: "i1" }),
      observed: observed({ externalRecordId: "r1" }),
    };
    expect(applyOperationsFor(diff, [tombstone])).toEqual([
      {
        kind: "delete",
        externalRecordId: "r1",
        record: { type: "A", name: "@", content: "203.0.113.10" },
      },
    ]);
  });

  it("does not delete a MANUAL record even when it is soft-deleted", () => {
    const diff = diffDnsRecords([], []);
    const tombstone = {
      intent: intent({ id: "i1", owner: "manual" }),
      observed: observed({ externalRecordId: "r1" }),
    };
    expect(applyOperationsFor(diff, [tombstone])).toEqual([]);
  });

  it("guards the unexpected rule structurally, not just by omission", () => {
    const diff = diffDnsRecords([], [observed({ externalRecordId: "r1" })]);
    // A hand-assembled operation list that violates the rule must throw.
    expect(() =>
      assertNoUnexpectedDeletions(diff, [
        {
          kind: "delete",
          externalRecordId: "r1",
          record: { type: "A", name: "@", content: "203.0.113.10" },
        },
      ]),
    ).toThrow(/refusing to delete an unexpected provider record/);

    // And the operations the builder actually produces must pass it.
    expect(() =>
      assertNoUnexpectedDeletions(diff, applyOperationsFor(diff)),
    ).not.toThrow();
  });
});
