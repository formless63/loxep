/**
 * THE acceptance-critical test, written first per the design's own
 * instruction ("write the never-auto-commit test first — a parse result
 * must be provably unable to reach `expenses`, `acquisitions`, or
 * `inventory_items` without an actor").
 *
 * `@loxep/documents` exposes NO function that writes any of those three
 * tables — this suite proves it two ways:
 *
 * 1. **Structural**: the package's public surface (`index.ts`) has no export
 *    whose name suggests such a write, and its manifest declares no
 *    dependency on `@loxep/accounting` or `@loxep/inventory` (the packages
 *    that DO own those writes) — see `documents.test.ts`'s companion
 *    assertion and `package.json` itself.
 * 2. **Behavioral, against real PostgreSQL**: drive a document from upload
 *    through parsing, manual line entry, and every disposition (including
 *    the ones that LOOK like they should confirm — `expense`,
 *    `acquisition_cost`, `inventory_intake`, `supplies`) to
 *    `stampConfirmed` — the ONE function in this package that touches
 *    `confirmed_at`/`target_kind`/`target_id` — and assert `expenses`,
 *    `acquisitions`, and `inventory_items` have EXACTLY as many rows after
 *    as before: zero, throughout, because this package can insert into
 *    none of them (no `insert(expenses)`/`insert(acquisitions)`/
 *    `insert(inventoryItems)` exists anywhere in its source).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCandidatesService,
  createDocumentsService,
  type CandidatesService,
  type DocumentsService,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  domainFactCounts,
  seedMediaObject,
  seedUser,
  type ScratchDb,
} from "./helpers.ts";

describe("never-auto-commit: a parse result cannot reach expenses/acquisitions/inventory_items", () => {
  let scratch: ScratchDb;
  let documentsService: DocumentsService;
  let candidates: CandidatesService;
  let actorId: string;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_docs_no_autocommit");
    documentsService = createDocumentsService({ db: scratch.handle.db });
    candidates = createCandidatesService({ db: scratch.handle.db });
    actorId = await seedUser(scratch, "no_autocommit_actor");
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  it("has zero facts in expenses/acquisitions/inventory_items before anything happens", async () => {
    const before = await domainFactCounts(scratch);
    expect(before).toEqual({ expenses: 0, acquisitions: 0, inventoryItems: 0 });
  });

  it("stays at zero through upload, manual parse, line entry, and every disposition — including 'confirming' ones — with NO actor", async () => {
    const before = await domainFactCounts(scratch);

    const mediaObjectId = await seedMediaObject(scratch, "estate-sale-receipt.jpg");
    const document = await documentsService.attachMedia({
      documentKind: "receipt",
      mediaObjectId,
    });

    // The manual-assisted backend "parses" the document — zero automatic
    // lines, by design (OQ3: manual-assisted only this milestone).
    const { manualParser } = await import("../src/index.ts");
    const parseResult = await manualParser.parse({
      mediaObjectId,
      documentKind: "receipt",
    });
    await documentsService.recordParseResult({ documentId: document.id, result: parseResult });

    // The operator transcribes four lines by hand, one per disposition that
    // looks like it should confirm into a domain table.
    const dispositions = ["expense", "acquisition_cost", "inventory_intake", "supplies"] as const;
    const lines = await Promise.all(
      dispositions.map((disposition) =>
        candidates.addLine({
          documentId: document.id,
          description: `${disposition} candidate`,
          lineAmount: "12.500000",
          currency: "USD",
          disposition,
        }),
      ),
    );

    // Setting a disposition — even 'expense' — never touches a domain table.
    const midway = await domainFactCounts(scratch);
    expect(midway).toEqual(before);

    // `stampConfirmed` with NO actor is not even callable: `actorUserId` is
    // a REQUIRED (non-optional) field on its Zod schema, so a caller that
    // omits it fails validation before touching the database at all — the
    // same class of guarantee `expenses.create({ status: 'recorded' })`
    // would need a caller-supplied actor for, made structural here.
    await expect(
      // @ts-expect-error — actorUserId is deliberately required, not optional.
      candidates.stampConfirmed({
        candidateId: lines[0]!.id,
        targetKind: "expense",
        targetId: crypto.randomUUID(),
      }),
    ).rejects.toThrow();

    const afterRejectedConfirm = await domainFactCounts(scratch);
    expect(afterRejectedConfirm).toEqual(before);
  });

  it("stampConfirmed WITH an actor still writes only its own columns — it is a STAMP, never a domain insert", async () => {
    const before = await domainFactCounts(scratch);
    const document = await documentsService.createFromCsv({});
    const { candidates: staged } = await documentsService.stageCsvRows({
      documentId: document.id,
      rows: [
        {
          lineNumber: 1,
          description: "Shipping supplies",
          lineAmount: "9.990000",
          lineDate: "2026-03-01",
          currency: "USD",
          payeeName: "Uline",
          rowFingerprint: "fp-never-auto-commit-1",
          rowWarnings: [],
        },
      ],
    });
    const candidate = staged[0]!;
    expect(candidate.disposition).toBe("expense");

    // This is the shape a CONSUMING domain's confirm function uses: stamp
    // a target this package never validated exists (a random uuid), because
    // this package has no foreign key into `expenses` and cannot check —
    // exactly the "stamp, not a foreign key" design decision.
    const fakeExpenseId = crypto.randomUUID();
    const confirmed = await candidates.stampConfirmed({
      candidateId: candidate.id,
      targetKind: "expense",
      targetId: fakeExpenseId,
      actorUserId: actorId,
    });
    expect(confirmed.confirmedAt).not.toBeNull();
    expect(confirmed.targetKind).toBe("expense");
    expect(confirmed.targetId).toBe(fakeExpenseId);

    // Still zero — stamping a candidate never inserts into expenses, no
    // matter how "confirmed" the candidate now looks.
    const after = await domainFactCounts(scratch);
    expect(after).toEqual(before);
  });

  it("declares no dependency on @loxep/accounting or @loxep/inventory (the packages that DO own those writes)", async () => {
    const manifest = await import("../package.json", { with: { type: "json" } });
    const dependencies = Object.keys(
      (manifest.default as { dependencies?: Record<string, string> }).dependencies ?? {},
    );
    expect(dependencies).not.toContain("@loxep/accounting");
    expect(dependencies).not.toContain("@loxep/inventory");
  });
});
