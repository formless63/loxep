/**
 * `accounting.post-facts` wiring tests (loxep-6fm): the task/cron shape, the
 * sweep actually posting a real fact through a real book (proving the
 * Financial dashboard band's own query fills), idempotency across a
 * redelivered fact and a repeated whole-sweep run, and the archived-book
 * gating fix in `posting-engine.ts` (a genuine engine-contract gap this bead
 * closed — see that module's "GAP FIX (loxep-6fm)" comment).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, runMigrations } from "@loxep/db";
import { economicEntities, user } from "@loxep/db/schema";
import type { DbHandle } from "@loxep/db";
import {
  createBooksService,
  createExpensesService,
  createPostingEngine,
} from "@loxep/accounting";
import { jobKeyFor } from "@loxep/jobs";
import type { TaskContext } from "@loxep/jobs";
import {
  ACCOUNTING_POST_FACTS_CRON_MATCH,
  ACCOUNTING_POST_FACTS_TASK_NAME,
  buildAppServices,
  createAccountingPostFactsTasks,
  runAccountingPostFactsSweep,
} from "../src/index.ts";
import type { AppServices } from "../src/index.ts";
import {
  createScratchDb,
  dropScratchDb,
  scratchDbName,
  silentJobsLogger,
  silentLogger,
  testConfig,
} from "./helpers.ts";

function noopHelpers(): TaskContext["helpers"] {
  return { addJob: async () => ({}) as never } as unknown as TaskContext["helpers"];
}

describe("accounting.post-facts", () => {
  const dbName = scratchDbName("loxep_test_app_accounting_posting");
  let databaseUrl = "";
  let handle: DbHandle;
  let services: AppServices;
  let books: ReturnType<typeof createBooksService>;
  let expenses: ReturnType<typeof createExpensesService>;
  let counter = 0;

  beforeAll(async () => {
    databaseUrl = await createScratchDb(dbName);
    await runMigrations({ databaseUrl, logger: silentLogger });
    handle = createDb(databaseUrl);
    services = buildAppServices({
      config: testConfig(databaseUrl),
      logger: silentJobsLogger,
    });
    books = createBooksService({ db: handle.db });
    expenses = createExpensesService({ db: handle.db });
    await handle.db.insert(user).values({
      id: "accounting-posting-test-fixture",
      name: "Accounting Posting Fixture",
      email: "accounting-posting@example.invalid",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }, 120_000);

  afterAll(async () => {
    await services?.close();
    await closeDb(handle);
    await dropScratchDb(dbName);
  });

  /** A book (with its default chart + 2026 fiscal periods) and an entity linked to it. */
  async function newFixture() {
    counter += 1;
    const [entity] = await handle.db
      .insert(economicEntities)
      .values({ name: `Pump LLC ${counter}`, kind: "llc" })
      .returning({ id: economicEntities.id });
    const entityId = entity?.id;
    if (entityId === undefined) throw new Error("entity insert returned no row");
    const { book } = await books.createBook({
      code: `PUMP-${counter}`,
      name: `Pump ${counter}`,
      openedOn: "2026-01-01",
    });
    await books.linkEntity({
      accountingBookId: book.id,
      economicEntityId: entityId,
      linkRole: "posting_primary",
      effectiveFrom: "2026-01-01",
    });
    return { book, entityId };
  }

  it("has the expected task name and a 5-minute cron match", () => {
    const tasks = createAccountingPostFactsTasks({ services });
    expect(tasks.accountingPostFactsTask.name).toBe(
      ACCOUNTING_POST_FACTS_TASK_NAME,
    );
    expect(tasks.accountingPostFactsCronItem.match).toBe(
      ACCOUNTING_POST_FACTS_CRON_MATCH,
    );
    expect(tasks.accountingPostFactsCronItem.options.jobKey).toBe(
      jobKeyFor(ACCOUNTING_POST_FACTS_TASK_NAME, "cron"),
    );
    expect(tasks.accountingPostFactsCronItem.options.jobKeyMode).toBe(
      "replace",
    );
  });

  it("posts a recorded expense through the sweep, and the Financial band's own query fills", async () => {
    const { book, entityId } = await newFixture();
    const created = await expenses.create({
      economicEntityId: entityId,
      expenseDate: "2026-04-10",
      category: "postage",
      payeeName: "USPS",
      currency: "USD",
      amount: "42.50",
      paymentMethod: "card",
      status: "recorded",
    });

    // `runAccountingPostFactsSweep` is what the task handler calls; using it
    // directly here (rather than the handler, whose return type is `unknown`
    // per `@loxep/jobs`' `TaskHandler` contract) keeps the result typed.
    const result = await runAccountingPostFactsSweep({ services });
    expect(result.posted).toBeGreaterThanOrEqual(1);
    expect(result.unpostable).toBe(0);

    // Mirrors `apps/web/src/server/dashboard-functions.ts`'s `fetchDashboardFinancial`
    // query shape: revenue/expense totals over `journal_lines` joined through
    // `journal_entries`/`ledger_accounts`, filtered to the book, the fiscal
    // period, and `status in ('posted', 'reversed')` — exactly what the
    // Financial dashboard band reads. Proving THIS query returns the posted
    // expense is what proves the band would fill, without importing
    // `apps/web` (out of this bead's write fence) into a package test.
    const totals = await handle.pool.query<{
      expenses: string;
    }>(
      `select coalesce(sum(l.functional_amount)
                filter (where a.account_type = 'expense'), 0)::numeric(20, 6)::text as expenses
         from journal_lines l
         join journal_entries e on e.id = l.journal_entry_id
         join ledger_accounts a on a.id = l.ledger_account_id
        where l.accounting_book_id = $1
          and a.account_type = 'expense'
          and e.status in ('posted', 'reversed')
          and e.entry_date >= '2026-04-01'
          and e.entry_date <= '2026-04-30'`,
      [book.id],
    );
    expect(totals.rows[0]?.expenses).toBe("42.500000");

    // Confirms `expense-functions.ts`'s corrected comment: postedness is
    // answered by the journal (source-fact identity), never by a transition
    // of `expenses.status` — the row stays `recorded` even after the sweep
    // posts it.
    const row = await handle.db.query.expenses.findFirst({
      where: (table, { eq }) => eq(table.id, created.expense.id),
    });
    expect(row?.status).toBe("recorded");
  });

  it("is idempotent: a redelivered fact and a repeated whole-sweep run never duplicate an entry", async () => {
    const { entityId } = await newFixture();
    const created = await expenses.create({
      economicEntityId: entityId,
      expenseDate: "2026-05-05",
      category: "bank_fees",
      currency: "USD",
      amount: "9.99",
      paymentMethod: "bank_transfer",
      status: "recorded",
    });

    // Prove the ENGINE's own idempotency: calling `evaluateFact` again on the
    // exact same source fact — the shape a redelivered at-least-once job
    // takes — is a no-op via the posting_key/fingerprint discipline, not a
    // second entry.
    const engine = createPostingEngine({ db: services.db });
    const first = await engine.evaluateFact({
      sourceFactType: "expense",
      sourceFactId: created.expense.id,
    });
    expect(first.status).toBe("posted");
    const retry = await engine.evaluateFact({
      sourceFactType: "expense",
      sourceFactId: created.expense.id,
    });
    expect(retry.status).toBe("unchanged");
    expect(retry.entry?.id).toBe(first.entry?.id);

    const afterEngineRetry = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n from journal_entries
        where source_fact_type = 'expense' and source_fact_id = $1
          and status = 'posted'`,
      [created.expense.id],
    );
    expect(Number(afterEngineRetry.rows[0]?.n ?? "0")).toBe(1);

    // Prove the WHOLE TASK is safe to run twice back-to-back (an overlapping
    // cron tick, or a redelivered job re-running the sweep from scratch).
    const tasks = createAccountingPostFactsTasks({ services });
    await tasks.accountingPostFactsTask.handler(
      {},
      { logger: silentJobsLogger, helpers: noopHelpers() },
    );
    await expect(
      tasks.accountingPostFactsTask.handler(
        {},
        { logger: silentJobsLogger, helpers: noopHelpers() },
      ),
    ).resolves.toBeDefined();

    const dedup = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n from (
         select source_fact_type, source_fact_id, count(*) as c
           from journal_entries
          where source_fact_type is not null and status = 'posted'
          group by source_fact_type, source_fact_id
         having count(*) > 1
       ) dupes`,
    );
    expect(Number(dedup.rows[0]?.n ?? "0")).toBe(0);
  });

  it("skips a fact routed to an archived (disabled) book without erroring the whole sweep", async () => {
    // Books gating (Phase 5's toggleable books): an entity whose book has
    // been archived must not post, and must not throw and abort every OTHER
    // fact this run — see posting-engine.ts's "GAP FIX (loxep-6fm)".
    const disabled = await newFixture();
    await books.archiveBook({ accountingBookId: disabled.book.id });
    const blockedExpense = await expenses.create({
      economicEntityId: disabled.entityId,
      expenseDate: "2026-06-01",
      category: "postage",
      currency: "USD",
      amount: "5",
      paymentMethod: "card",
      status: "recorded",
    });

    // A second, ordinary fixture in the SAME run proves the disabled book
    // did not take the whole sweep down with it.
    const { entityId: okEntityId } = await newFixture();
    const okExpense = await expenses.create({
      economicEntityId: okEntityId,
      expenseDate: "2026-06-01",
      category: "postage",
      currency: "USD",
      amount: "7",
      paymentMethod: "card",
      status: "recorded",
    });

    const result = await runAccountingPostFactsSweep({ services });
    expect(result.unpostableByReason["no_route"]).toBeGreaterThanOrEqual(1);
    expect(result.posted).toBeGreaterThanOrEqual(1);

    const blockedEntries = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n from journal_entries
        where source_fact_type = 'expense' and source_fact_id = $1`,
      [blockedExpense.expense.id],
    );
    expect(Number(blockedEntries.rows[0]?.n ?? "0")).toBe(0);

    const okEntries = await handle.pool.query<{ n: string }>(
      `select count(*)::text as n from journal_entries
        where source_fact_type = 'expense' and source_fact_id = $1
          and status = 'posted'`,
      [okExpense.expense.id],
    );
    expect(Number(okEntries.rows[0]?.n ?? "0")).toBe(1);
  });
});
