/**
 * The declarative rule model: authoring, validation, versioning, and the
 * immutability the owner's second answer requires.
 *
 * Real PostgreSQL, because the two rules that matter most here — a version
 * frozen once an entry references it, and the partial unique that permits one
 * `remainder` line — live in migration 0010's DDL and triggers, not in
 * TypeScript.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBooksService,
  createPostingEngine,
  createPostingRulesService,
  validatePostingRuleTemplate,
} from "../src/index.ts";
import {
  createMigratedScratchDb,
  seedConnection,
  seedEntity,
  seedOrder,
} from "./helpers.ts";
import type { ScratchDb } from "./helpers.ts";

describe("posting rules", () => {
  let scratch: ScratchDb;
  let rules: ReturnType<typeof createPostingRulesService>;
  let books: ReturnType<typeof createBooksService>;
  let engine: ReturnType<typeof createPostingEngine>;
  let counter = 0;

  beforeAll(async () => {
    scratch = await createMigratedScratchDb("loxep_test_acct_rules");
    rules = createPostingRulesService({ db: scratch.handle.db });
    books = createBooksService({ db: scratch.handle.db });
    engine = createPostingEngine({ db: scratch.handle.db });
  }, 120_000);

  afterAll(async () => {
    await scratch.close();
  });

  function uniqueCode(prefix: string): string {
    counter += 1;
    return `${prefix}_${counter}`;
  }

  const saleLines = [
    { accountSystemKey: "marketplace_clearing", amountSource: "total" as const },
    {
      accountSystemKey: "sales_revenue",
      amountSource: "subtotal" as const,
      amountMultiplier: "-1",
    },
    { accountSystemKey: "suspense", amountSource: "remainder" as const },
  ];

  describe("validation at save time, never at posting time", () => {
    it("refuses a fact type nothing can read", async () => {
      await expect(
        rules.createRule({
          code: uniqueCode("bad_type"),
          name: "Payout",
          sourceFactType: "payout",
          lines: saleLines,
        }),
      ).rejects.toThrow(/no source-fact reader exists/);
    });

    it("refuses a predicate the fact type cannot carry", async () => {
      // `fee_direction` is a column on order_fees, not on orders: a rule
      // selecting orders by it would silently never fire.
      await expect(
        rules.createRule({
          code: uniqueCode("bad_predicate"),
          name: "Sale",
          sourceFactType: "order",
          matchFeeDirection: "seller_charge",
          lines: saleLines,
        }),
      ).rejects.toThrow(/does not apply to a order fact/);
    });

    it("refuses an amount source the fact does not carry", async () => {
      await expect(
        rules.createRule({
          code: uniqueCode("bad_amount"),
          name: "Fee",
          sourceFactType: "order_fee",
          lines: [
            { accountSystemKey: "marketplace_fees", amountSource: "subtotal" },
            {
              accountSystemKey: "marketplace_clearing",
              amountSource: "fee",
              amountMultiplier: "-1",
            },
          ],
        }),
      ).rejects.toThrow(/carries no "subtotal" amount/);
    });

    it("refuses a system key no seeded account carries", async () => {
      await expect(
        rules.createRule({
          code: uniqueCode("bad_key"),
          name: "Sale",
          sourceFactType: "order",
          lines: [
            { accountSystemKey: "clearing_account", amountSource: "total" },
            {
              accountSystemKey: "sales_revenue",
              amountSource: "total",
              amountMultiplier: "-1",
            },
          ],
        }),
      ).rejects.toThrow(/is not a Loxep system key/);
    });

    it("refuses an unknown description placeholder", async () => {
      await expect(
        rules.createRule({
          code: uniqueCode("bad_placeholder"),
          name: "Sale",
          sourceFactType: "order",
          lines: [
            {
              accountSystemKey: "marketplace_clearing",
              amountSource: "total",
              descriptionTemplate: "sale to {buyer_email}",
            },
            {
              accountSystemKey: "sales_revenue",
              amountSource: "total",
              amountMultiplier: "-1",
            },
          ],
        }),
      ).rejects.toThrow(/is not a placeholder a order fact carries/);
    });

    it("refuses a template that cannot balance, symbolically, with no plug", () => {
      // Balances only when shipping and tax happen to be zero — which is to
      // say, on the orders that would not have exposed the bug.
      expect(() =>
        validatePostingRuleTemplate("order", [
          {
            accountSystemKey: "marketplace_clearing",
            amountSource: "total",
            amountMultiplier: "1",
            inheritEntity: true,
          },
          {
            accountSystemKey: "sales_revenue",
            amountSource: "subtotal",
            amountMultiplier: "-1",
            inheritEntity: true,
          },
        ]),
      ).toThrow(/cannot balance for every fact/);
    });

    it("accepts a plugless template whose components cancel identically", () => {
      expect(() =>
        validatePostingRuleTemplate("order", [
          {
            accountSystemKey: "marketplace_clearing",
            amountSource: "total",
            amountMultiplier: "1",
            inheritEntity: true,
          },
          {
            accountSystemKey: "sales_revenue",
            amountSource: "subtotal",
            amountMultiplier: "-1",
            inheritEntity: true,
          },
          {
            accountSystemKey: "shipping_income",
            amountSource: "shipping",
            amountMultiplier: "-1",
            inheritEntity: true,
          },
          {
            accountSystemKey: "facilitator_tax_clearing",
            amountSource: "tax",
            amountMultiplier: "-1",
            inheritEntity: true,
          },
          {
            accountSystemKey: "sales_revenue",
            amountSource: "discount",
            amountMultiplier: "1",
            inheritEntity: true,
          },
        ]),
      ).not.toThrow();
    });

    it("refuses two remainder lines in one version", async () => {
      await expect(
        rules.createRule({
          code: uniqueCode("two_plugs"),
          name: "Sale",
          sourceFactType: "order",
          lines: [
            { accountSystemKey: "marketplace_clearing", amountSource: "total" },
            { accountSystemKey: "suspense", amountSource: "remainder" },
            { accountSystemKey: "sales_revenue", amountSource: "remainder" },
          ],
        }),
      ).rejects.toThrow(/at most one `remainder` line/);
    });
  });

  describe("versioning", () => {
    it("mints version N+1, supersedes N, and moves current_version_id", async () => {
      const code = uniqueCode("versioned");
      const created = await rules.createRule({
        code,
        name: "Sale",
        sourceFactType: "order",
        lines: saleLines,
        activate: true,
      });
      expect(created.rule.currentVersionId).toBe(created.version.id);
      expect(created.rule.status).toBe("active");

      const second = await rules.addVersion({
        postingRuleId: created.rule.id,
        lines: saleLines,
        activate: true,
      });
      expect(second.version.version).toBe(2);
      expect(second.rule.currentVersionId).toBe(second.version.id);

      const versions = await rules.listVersions(created.rule.id);
      expect(versions.map((version) => version.status)).toEqual([
        "superseded",
        "active",
      ]);
    });

    it("refuses to reactivate a superseded version", async () => {
      const created = await rules.createRule({
        code: uniqueCode("no_reactivate"),
        name: "Sale",
        sourceFactType: "order",
        lines: saleLines,
        activate: true,
      });
      await rules.addVersion({
        postingRuleId: created.rule.id,
        lines: saleLines,
        activate: true,
      });
      await expect(
        rules.activateVersion({ postingRuleVersionId: created.version.id }),
      ).rejects.toThrow(/superseded/);
    });

    it("refuses to activate a rule with no version", async () => {
      const created = await rules.createRule({
        code: uniqueCode("unactivatable"),
        name: "Sale",
        sourceFactType: "order",
        lines: saleLines,
      });
      await expect(
        rules.setRuleStatus({ postingRuleId: created.rule.id, status: "active" }),
      ).rejects.toThrow(/no active version/);
    });
  });

  describe("immutability once an entry references a version", () => {
    it("freezes the version's text and its lines at the DATABASE", async () => {
      const entityId = await seedEntity(scratch, "Immutable LLC");
      const { book } = await books.createBook({
        code: uniqueCode("IMM"),
        name: "Immutable",
        openedOn: "2026-01-01",
      });
      await books.linkEntity({
        accountingBookId: book.id,
        economicEntityId: entityId,
        linkRole: "posting_primary",
        effectiveFrom: "2026-01-01",
      });
      const connectionId = await seedConnection(scratch);
      const orderId = await seedOrder(scratch, {
        connectionId,
        economicEntityId: entityId,
        externalOrderId: uniqueCode("ORD"),
        subtotal: "100",
        total: "100",
      });

      const code = uniqueCode("frozen");
      const created = await rules.createRule({
        code,
        name: "Sale",
        sourceFactType: "order",
        // Narrow to this book so the shared fixture's other rules cannot claim
        // the fact first.
        accountingBookId: book.id,
        priority: 10,
        lines: saleLines,
        activate: true,
      });

      const outcome = await engine.evaluateFact({
        sourceFactType: "order",
        sourceFactId: orderId,
      });
      expect(outcome.status).toBe("posted");
      expect(outcome.rule?.code).toBe(code);

      // A predicate edit on a referenced version: refused.
      await expect(
        scratch.handle.pool.query(
          `update posting_rule_versions set match_provider = 'woocommerce'
            where id = $1`,
          [created.version.id],
        ),
      ).rejects.toThrow(/immutable/);

      // Its template: refused for update, delete, AND insert.
      await expect(
        scratch.handle.pool.query(
          `update posting_rule_lines set amount_multiplier = 2
            where posting_rule_version_id = $1`,
          [created.version.id],
        ),
      ).rejects.toThrow(/line template is not permitted/);
      await expect(
        scratch.handle.pool.query(
          `delete from posting_rule_lines where posting_rule_version_id = $1`,
          [created.version.id],
        ),
      ).rejects.toThrow(/line template is not permitted/);
      await expect(
        scratch.handle.pool.query(
          `insert into posting_rule_lines
             (posting_rule_version_id, line_number, account_system_key, amount_source)
           values ($1, 99, 'suspense', 'total')`,
          [created.version.id],
        ),
      ).rejects.toThrow(/line template is not permitted/);

      // Deleting it would orphan the explanation of a posted entry.
      await expect(
        scratch.handle.pool.query(
          `delete from posting_rule_versions where id = $1`,
          [created.version.id],
        ),
      ).rejects.toThrow(/may not be deleted/);

      // The lifecycle stays available: superseding is not an edit of the text.
      await rules.addVersion({
        postingRuleId: created.rule.id,
        lines: saleLines,
        activate: true,
      });
      const versions = await rules.listVersions(created.rule.id);
      expect(versions[0]?.status).toBe("superseded");
    });

    it("leaves an UNREFERENCED version freely editable", async () => {
      const created = await rules.createRule({
        code: uniqueCode("draftable"),
        name: "Sale",
        sourceFactType: "order",
        lines: saleLines,
      });
      await scratch.handle.pool.query(
        `update posting_rule_versions set note = 'still being authored'
          where id = $1`,
        [created.version.id],
      );
      const { version } = await rules.getVersion(created.version.id);
      expect(version.note).toBe("still being authored");
    });
  });

  describe("the shipped rule set", () => {
    it("seeds idempotently and validates every template it ships", async () => {
      const first = await engine.seedDefaultRules();
      expect(first.created).toContain("order_sale");
      expect(first.created).toContain("order_fee_seller_charge");
      expect(first.created).toContain("order_fee_buyer_surcharge");
      expect(first.created).toContain("order_refund");
      expect(first.existing).toEqual([]);

      const second = await engine.seedDefaultRules();
      expect(second.created).toEqual([]);
      expect(second.existing.length).toBe(first.created.length);

      const active = await rules.listRules({ statuses: ["active"] });
      const seeded = active.filter((rule) =>
        first.created.includes(rule.code),
      );
      expect(seeded.length).toBe(first.created.length);
      for (const rule of seeded) {
        expect(rule.currentVersionId).not.toBeNull();
      }
    });

    it("orders expense rules so the specific ones claim before the catch-all", async () => {
      await engine.seedDefaultRules();
      const expenseRules = await rules.listRules({
        sourceFactType: "expense",
        statuses: ["active"],
      });
      const codes = expenseRules.map((rule) => rule.code);
      expect(codes[codes.length - 1]).toBe("expense_uncategorized");
      expect(codes).toContain("expense_postage");
    });
  });
});
