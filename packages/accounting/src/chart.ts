/**
 * The per-book chart of accounts: creation from the code-owned template,
 * operator edits, and the two rules that keep Loxep's own postings resolvable.
 *
 * ## What an operator may change, and what nothing may change
 *
 * ```text
 * code, name, description, parent   freely, including on system accounts —
 *                                   account numbering is an opinion operators
 *                                   are entitled to
 * status -> archived                on ordinary accounts, and never on a
 *                                   system account
 * account_type                      NEVER. It decides which statement an
 *                                   account appears on, and changing it moves
 *                                   history between statements silently
 * system_key                        NEVER. It is the handle every shipped rule
 *                                   resolves through
 * deletion                          NEVER, for anything. There is no delete
 *                                   method in this service
 * ```
 *
 * The last one is not an omission. An account with posted lines cannot be
 * deleted without destroying the entries that reference it, and an account
 * without posted lines is one archive away from being out of the way.
 *
 * ## `normal_balance` is computed, never stored
 *
 * It is `debit` for `asset`/`expense` and `credit` for
 * `liability`/`equity`/`revenue`, flipped by `is_contra`. Storing it would
 * create a second source for a derived fact with no arbiter — the same
 * argument that kept money totals off `acquisitions` and `debit`/`credit`
 * columns off `journal_lines`.
 *
 * ## Postability is a service rule with a database safety net
 *
 * `is_postable = false` marks a roll-up header, and "a journal line may only
 * reference a postable account" is a CROSS-TABLE condition that no `CHECK` can
 * express. It is therefore enforced here, at the posting boundary in
 * `journal.ts`, and by the "posted lines against non-postable accounts" report.
 * A trigger is available if a real incident ever argues for one; inventing it
 * before that would be the only trigger in this schema not paying for a proven
 * failure.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { ledgerAccounts } from "@loxep/db/schema";
import {
  LEDGER_ACCOUNT_TYPES,
  LEDGER_SYSTEM_KEYS,
} from "@loxep/db/schema";
import type { LedgerAccountType } from "@loxep/db/schema";
import { z } from "zod";
import { DEFAULT_CHART_TEMPLATE } from "./chart-template.ts";
import type { ChartTemplateAccount } from "./chart-template.ts";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  LedgerImmutableError,
} from "./errors.ts";
import { textLiteral, uuidLiteral } from "./sql.ts";

export type LedgerAccountRow = typeof ledgerAccounts.$inferSelect;

type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

/** `debit` for asset/expense, `credit` for liability/equity/revenue, flipped by contra. */
export function normalBalanceOf(
  accountType: LedgerAccountType,
  isContra = false,
): "debit" | "credit" {
  const natural =
    accountType === "asset" || accountType === "expense" ? "debit" : "credit";
  if (!isContra) return natural;
  return natural === "debit" ? "credit" : "debit";
}

const accountTypeSchema = z.enum(LEDGER_ACCOUNT_TYPES);
const systemKeySchema = z.enum(LEDGER_SYSTEM_KEYS);

const createAccountSchema = z.strictObject({
  accountingBookId: z.uuid(),
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  accountType: accountTypeSchema,
  accountSubtype: z.string().trim().min(1).nullish(),
  /**
   * Validated against the closed set rather than accepted as free text: an
   * invented system key is a handle no rule will ever resolve, which reads as a
   * working configuration and behaves as a silent suspense posting.
   */
  systemKey: systemKeySchema.nullish(),
  parentAccountId: z.uuid().nullish(),
  isPostable: z.boolean().default(true),
  isContra: z.boolean().default(false),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "expected an ISO-4217 alphabetic code")
    .nullish(),
  description: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type CreateAccountInput = z.input<typeof createAccountSchema>;

const updateAccountSchema = z.strictObject({
  ledgerAccountId: z.uuid(),
  code: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  accountSubtype: z.string().trim().min(1).nullish(),
  parentAccountId: z.uuid().nullish(),
  isPostable: z.boolean().optional(),
  description: z.string().trim().min(1).nullish(),
  actorUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type UpdateAccountInput = z.input<typeof updateAccountSchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid account input: ${issues}`);
  }
  return parsed.data;
}

export interface AccountsService {
  /**
   * Copy the code-owned template into a book, once. Idempotent by
   * `(book, code)`: re-running it against a seeded book adds nothing and
   * returns the accounts that are already there.
   */
  seedDefaultChart: (input: {
    accountingBookId: string;
    template?: readonly ChartTemplateAccount[];
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<LedgerAccountRow[]>;
  createAccount: (input: CreateAccountInput) => Promise<LedgerAccountRow>;
  updateAccount: (input: UpdateAccountInput) => Promise<LedgerAccountRow>;
  /** Ordinary accounts only — a system account is never archived or deleted. */
  archiveAccount: (input: {
    ledgerAccountId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<LedgerAccountRow>;
  reactivateAccount: (input: {
    ledgerAccountId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<LedgerAccountRow>;
  getAccount: (ledgerAccountId: string) => Promise<LedgerAccountRow>;
  findByCode: (
    accountingBookId: string,
    code: string,
  ) => Promise<LedgerAccountRow | null>;
  /** The resolution every shipped posting rule performs. */
  findBySystemKey: (
    accountingBookId: string,
    systemKey: string,
  ) => Promise<LedgerAccountRow | null>;
  requireSystemAccount: (
    accountingBookId: string,
    systemKey: string,
  ) => Promise<LedgerAccountRow>;
  listAccounts: (
    accountingBookId: string,
    options?: { includeArchived?: boolean; accountType?: LedgerAccountType },
  ) => Promise<LedgerAccountRow[]>;
}

export function createAccountsService(options: {
  db: LoxepDb;
}): AccountsService {
  const { db } = options;

  async function loadAccount(
    executor: Executor,
    ledgerAccountId: string,
  ): Promise<LedgerAccountRow> {
    const row = await executor.query.ledgerAccounts.findFirst({
      where: (table, { eq }) => eq(table.id, ledgerAccountId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown ledger account "${ledgerAccountId}"`,
      );
    }
    return row;
  }

  async function assertBookExists(
    executor: Executor,
    accountingBookId: string,
  ): Promise<void> {
    const book = await executor.query.accountingBooks.findFirst({
      where: (table, { eq }) => eq(table.id, accountingBookId),
      columns: { id: true },
    });
    if (book === undefined) {
      throw new AccountingNotFoundError(
        `unknown accounting book "${accountingBookId}"`,
      );
    }
  }

  async function seed(
    executor: Executor,
    accountingBookId: string,
    template: readonly ChartTemplateAccount[],
  ): Promise<LedgerAccountRow[]> {
    // Two passes, because a parent must exist before the child references it
    // and the template is written in reading order rather than dependency
    // order. The alternative — a topological sort of a twenty-row constant —
    // would be cleverness paid for by nobody.
    const byCode = new Map<string, LedgerAccountRow>();
    const existing = await executor.query.ledgerAccounts.findMany({
      where: (table, { eq }) => eq(table.accountingBookId, accountingBookId),
    });
    for (const row of existing) byCode.set(row.code, row);

    const ordered = [
      ...template.filter((account) => account.parentCode === undefined),
      ...template.filter((account) => account.parentCode !== undefined),
    ];

    for (const account of ordered) {
      if (byCode.has(account.code)) continue;
      const parent =
        account.parentCode === undefined
          ? null
          : (byCode.get(account.parentCode) ?? null);
      if (account.parentCode !== undefined && parent === null) {
        throw new AccountingValidationError(
          `chart template account ${account.code} names parent ` +
            `${account.parentCode}, which the template does not define`,
        );
      }
      const inserted = await executor
        .insert(ledgerAccounts)
        .values({
          accountingBookId,
          code: account.code,
          name: account.name,
          accountType: account.accountType,
          accountSubtype: account.accountSubtype ?? null,
          systemKey: account.systemKey ?? null,
          parentAccountId: parent?.id ?? null,
          isPostable: account.isPostable ?? true,
          isContra: account.isContra ?? false,
          description: account.description ?? null,
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new AccountingConflictError(
          "ledger_accounts insert returned no row",
        );
      }
      byCode.set(row.code, row);
    }

    return [...byCode.values()].sort((left, right) =>
      left.code.localeCompare(right.code),
    );
  }

  return {
    seedDefaultChart: async (input) =>
      db.transaction(async (tx) => {
        await assertBookExists(tx, input.accountingBookId);
        const template = input.template ?? DEFAULT_CHART_TEMPLATE;
        const before = await tx.query.ledgerAccounts.findMany({
          where: (table, { eq }) =>
            eq(table.accountingBookId, input.accountingBookId),
          columns: { id: true },
        });
        const rows = await seed(tx, input.accountingBookId, template);
        if (rows.length > before.length) {
          await createAuditService({ db: tx }).append({
            actorUserId: input.actorUserId ?? null,
            action: "accounting.chart.seeded",
            resourceType: "accounting_book",
            resourceId: input.accountingBookId,
            after: { accountCount: rows.length },
            requestId: input.requestId ?? null,
            metadata: { created: rows.length - before.length },
          });
        }
        return rows;
      }),

    createAccount: async (input) => {
      const value = parse(createAccountSchema, input);
      return db.transaction(async (tx) => {
        await assertBookExists(tx, value.accountingBookId);
        if (value.parentAccountId !== undefined && value.parentAccountId !== null) {
          const parent = await loadAccount(tx, value.parentAccountId);
          if (parent.accountingBookId !== value.accountingBookId) {
            throw new AccountingValidationError(
              `parent account ${parent.code} belongs to another book: a chart ` +
                "hierarchy never crosses books (the composite foreign key " +
                "refuses it too)",
            );
          }
        }
        const inserted = await tx
          .insert(ledgerAccounts)
          .values({
            accountingBookId: value.accountingBookId,
            code: value.code,
            name: value.name,
            accountType: value.accountType,
            accountSubtype: value.accountSubtype ?? null,
            systemKey: value.systemKey ?? null,
            parentAccountId: value.parentAccountId ?? null,
            isPostable: value.isPostable,
            isContra: value.isContra,
            currency: value.currency?.toUpperCase() ?? null,
            description: value.description ?? null,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new AccountingConflictError(
            "ledger_accounts insert returned no row",
          );
        }
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "accounting.account.created",
          resourceType: "ledger_account",
          resourceId: row.id,
          after: {
            accountingBookId: row.accountingBookId,
            code: row.code,
            name: row.name,
            accountType: row.accountType,
            systemKey: row.systemKey,
          },
          requestId: value.requestId ?? null,
        });
        return row;
      });
    },

    updateAccount: async (input) => {
      const value = parse(updateAccountSchema, input);
      return db.transaction(async (tx) => {
        const before = await loadAccount(tx, value.ledgerAccountId);
        const assignments: string[] = ["updated_at = now()"];
        if (value.code !== undefined) {
          assignments.push(`code = ${textLiteral(value.code)}`);
        }
        if (value.name !== undefined) {
          assignments.push(`name = ${textLiteral(value.name)}`);
        }
        if (value.accountSubtype !== undefined) {
          assignments.push(
            `account_subtype = ${value.accountSubtype === null ? "null" : textLiteral(value.accountSubtype)}`,
          );
        }
        if (value.description !== undefined) {
          assignments.push(
            `description = ${value.description === null ? "null" : textLiteral(value.description)}`,
          );
        }
        if (value.parentAccountId !== undefined) {
          if (value.parentAccountId === null) {
            assignments.push("parent_account_id = null");
          } else {
            const parent = await loadAccount(tx, value.parentAccountId);
            if (parent.accountingBookId !== before.accountingBookId) {
              throw new AccountingValidationError(
                `parent account ${parent.code} belongs to another book`,
              );
            }
            assignments.push(
              `parent_account_id = ${uuidLiteral(value.parentAccountId)}`,
            );
          }
        }
        if (value.isPostable !== undefined) {
          if (!value.isPostable) {
            const used = await tx.execute(
              `select 1 from journal_lines
                where ledger_account_id = ${uuidLiteral(before.id)} limit 1`,
            );
            if (used.rows.length > 0) {
              throw new AccountingValidationError(
                `account ${before.code} already carries journal lines and ` +
                  "cannot become a roll-up header: the lines that reference " +
                  "it would be exactly the finding the " +
                  '"posted lines against non-postable accounts" report exists ' +
                  "to surface",
              );
            }
          }
          assignments.push(`is_postable = ${value.isPostable}`);
        }

        await tx.execute(
          `update ledger_accounts set ${assignments.join(", ")}
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadAccount(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: value.actorUserId ?? null,
          action: "accounting.account.updated",
          resourceType: "ledger_account",
          resourceId: before.id,
          before: {
            code: before.code,
            name: before.name,
            parentAccountId: before.parentAccountId,
            isPostable: before.isPostable,
          },
          after: {
            code: after.code,
            name: after.name,
            parentAccountId: after.parentAccountId,
            isPostable: after.isPostable,
          },
          requestId: value.requestId ?? null,
          metadata: {
            // Stated in the audit trail because these are the two fields whose
            // ABSENCE from the update surface is the rule.
            immutable: "account_type, system_key",
            systemKey: before.systemKey,
          },
        });
        return after;
      });
    },

    archiveAccount: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadAccount(tx, input.ledgerAccountId);
        if (before.systemKey !== null) {
          throw new LedgerImmutableError(
            `account ${before.code} carries system key "${before.systemKey}" ` +
              "and may not be archived: every shipped posting rule resolves " +
              "through that handle, and an archived system account is a rule " +
              "that plugs to suspense without saying so. Rename it, re-code " +
              "it, or reparent it instead — those are all free.",
          );
        }
        if (before.status === "archived") return before;
        await tx.execute(
          `update ledger_accounts set status = 'archived', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadAccount(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.account.archived",
          resourceType: "ledger_account",
          resourceId: before.id,
          before: { status: before.status },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: { code: before.code, name: before.name },
        });
        return after;
      }),

    reactivateAccount: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadAccount(tx, input.ledgerAccountId);
        if (before.status === "active") return before;
        await tx.execute(
          `update ledger_accounts set status = 'active', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadAccount(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.account.reactivated",
          resourceType: "ledger_account",
          resourceId: before.id,
          before: { status: before.status },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: { code: before.code },
        });
        return after;
      }),

    getAccount: async (ledgerAccountId) => loadAccount(db, ledgerAccountId),

    findByCode: async (accountingBookId, code) => {
      const row = await db.query.ledgerAccounts.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.accountingBookId, accountingBookId),
            eq(table.code, code),
          ),
      });
      return row ?? null;
    },

    findBySystemKey: async (accountingBookId, systemKey) => {
      const row = await db.query.ledgerAccounts.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.accountingBookId, accountingBookId),
            eq(table.systemKey, systemKey),
          ),
      });
      return row ?? null;
    },

    requireSystemAccount: async (accountingBookId, systemKey) => {
      const row = await db.query.ledgerAccounts.findFirst({
        where: (table, { and, eq }) =>
          and(
            eq(table.accountingBookId, accountingBookId),
            eq(table.systemKey, systemKey),
          ),
      });
      if (row === undefined) {
        throw new AccountingNotFoundError(
          `book "${accountingBookId}" has no account carrying system key ` +
            `"${systemKey}". A rule resolving a key no account carries is a ` +
            "silent suspense posting, which is why this raises instead of " +
            "falling back.",
        );
      }
      return row;
    },

    listAccounts: async (accountingBookId, listOptions) =>
      db.query.ledgerAccounts.findMany({
        where: (table, { and, eq }) => {
          const predicates = [eq(table.accountingBookId, accountingBookId)];
          if (listOptions?.includeArchived !== true) {
            predicates.push(eq(table.status, "active"));
          }
          if (listOptions?.accountType !== undefined) {
            predicates.push(eq(table.accountType, listOptions.accountType));
          }
          return and(...predicates);
        },
        orderBy: (table, { asc }) => [asc(table.code)],
      }),
  };
}
