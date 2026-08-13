/**
 * Accounting books, the book-to-entity link, and the routing rule that decides
 * which book a fact posts to.
 *
 * ## The owner's answer, stated once
 *
 * Books are **toggleable per economic entity**, and entities relate as
 * *included-in / part-of*: an assumed name's activity must be viewable on its
 * own while its actual totals and financial impact land in the parent company's
 * book. Concretely:
 *
 * ```text
 * a child entity's posting_primary book IS its parent's book
 * per-entity views are REPORTING SLICES over journal_lines.economic_entity_id,
 *   never separate ledgers
 * onboarding defaults to one book per TOP-LEVEL entity
 * ```
 *
 * That single sentence is what {@link BooksService.linkEntity} enforces in both
 * directions and what {@link BooksService.resolveBookForEntity} implements: an
 * entity with no link of its own inherits its nearest ancestor's book, which is
 * exactly what "part of" means in accounting terms.
 *
 * ## Routing, and what happens when it fails
 *
 * ```text
 * 1 the fact carries an entity with a posting_primary link covering the date
 *     -> that book                     source = 'entity_link'
 * 2 the fact carries an entity whose ANCESTOR has one
 *     -> the ancestor's book           source = 'parent_entity_link'
 * 3 the fact carries no entity and an installation default is configured
 *     -> that book                     source = 'installation_default'
 * 4 otherwise
 *     -> the fact does not post; it enters the UNPOSTABLE BACKLOG
 * ```
 *
 * Step 4 is not a failure mode, it is the design. A fact with no entity and no
 * default book is a fact whose accounting ownership nobody has stated, and
 * inventing one silently is how a ledger becomes untrustworthy.
 *
 * The backlog itself is a read model, not a table — source facts with no
 * matching entry — because materializing it would create a second thing that
 * can drift from the facts.
 *
 * ## What this module refuses to add
 *
 * No `economic_entity_id` on `accounting_books`, ever. A book with an owning
 * entity is a one-book-per-entity model wearing a link table as a disguise, and
 * ADR-0017's prohibition on that shape is the single most-repeated rule in the
 * documentation. Ownership lives in `book_entity_links`, pointing inward.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { accountingBooks, bookEntityLinks } from "@loxep/db/schema";
import { z } from "zod";
import { createAccountsService } from "./chart.ts";
import type { ChartTemplateAccount } from "./chart-template.ts";
import {
  DEFAULT_FUNCTIONAL_CURRENCY,
  assertSupportedCurrency,
} from "./currency.ts";
import {
  AccountingConflictError,
  AccountingNotFoundError,
  AccountingValidationError,
  BookRoutingError,
} from "./errors.ts";
import {
  createFiscalPeriodsService,
  fiscalYearFor,
  isExclusionViolation,
} from "./periods.ts";
import { dateLiteral, uuidLiteral } from "./sql.ts";

export type AccountingBookRow = typeof accountingBooks.$inferSelect;
export type BookEntityLinkRow = typeof bookEntityLinks.$inferSelect;

type Executor = Pick<LoxepDb, "insert" | "execute" | "query">;

/** How a fact reached the book it posts to. Stamped on nothing; returned to the caller. */
export type PostingBookSource =
  | "entity_link"
  | "parent_entity_link"
  | "installation_default";

export interface BookRouting {
  accountingBookId: string;
  source: PostingBookSource;
  /** For `parent_entity_link`, the ancestor whose link supplied the book. */
  viaEconomicEntityId: string | null;
}

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a calendar date as YYYY-MM-DD");

const createBookSchema = z.strictObject({
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  functionalCurrency: z.string().trim().min(3).max(3).optional(),
  accountingBasis: z.enum(["cash", "accrual"]).default("accrual"),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(1),
  fiscalYearStartDay: z.number().int().min(1).max(31).default(1),
  requiresEntityDimension: z.boolean().default(false),
  openedOn: calendarDate,
  notes: z.string().trim().min(1).nullish(),
  /** The code-owned starter chart; pass `false` for a book an operator will build by hand. */
  seedChart: z.boolean().default(true),
  /** One fiscal year of monthly periods, generated at creation. */
  generatePeriods: z.boolean().default(true),
  createdByUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type CreateBookInput = z.input<typeof createBookSchema> & {
  template?: readonly ChartTemplateAccount[];
};

const linkEntitySchema = z.strictObject({
  accountingBookId: z.uuid(),
  economicEntityId: z.uuid(),
  linkRole: z.enum(["posting_primary", "reporting_only"]),
  effectiveFrom: calendarDate,
  effectiveTo: calendarDate.nullish(),
  dimensionLabel: z.string().trim().min(1).nullish(),
  note: z.string().trim().min(1).nullish(),
  createdByUserId: z.string().min(1).nullish(),
  requestId: z.string().min(1).nullish(),
});

export type LinkEntityInput = z.input<typeof linkEntitySchema>;

function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new AccountingValidationError(`invalid book input: ${issues}`);
  }
  return parsed.data;
}

export interface BooksService {
  /**
   * Create a book and, by default, give it a chart and a fiscal year — the
   * three things that are useless apart and that no operator should have to
   * remember to do in order.
   */
  createBook: (input: CreateBookInput) => Promise<{
    book: AccountingBookRow;
    accountCount: number;
    periodCount: number;
  }>;
  getBook: (accountingBookId: string) => Promise<AccountingBookRow>;
  findBookByCode: (code: string) => Promise<AccountingBookRow | null>;
  listBooks: (options?: {
    includeArchived?: boolean;
  }) => Promise<AccountingBookRow[]>;
  archiveBook: (input: {
    accountingBookId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<AccountingBookRow>;

  /** Enforces the roll-up rule in both directions; the DB enforces non-overlap. */
  linkEntity: (input: LinkEntityInput) => Promise<BookEntityLinkRow>;
  /** Close an open-ended link — how an entity moves books at a date boundary. */
  endLink: (input: {
    bookEntityLinkId: string;
    effectiveTo: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<BookEntityLinkRow>;
  listLinks: (options: {
    accountingBookId?: string;
    economicEntityId?: string;
    onDate?: string;
  }) => Promise<BookEntityLinkRow[]>;

  /** The routing decision, or null when the fact belongs in the unpostable backlog. */
  resolveBookForEntity: (input: {
    economicEntityId?: string | null;
    onDate: string;
    installationDefaultBookId?: string | null;
  }) => Promise<BookRouting | null>;
  /** {@link resolveBookForEntity}, raising with the backlog explanation instead of returning null. */
  requireBookForEntity: (input: {
    economicEntityId?: string | null;
    onDate: string;
    installationDefaultBookId?: string | null;
  }) => Promise<BookRouting>;
}

export function createBooksService(options: { db: LoxepDb }): BooksService {
  const { db } = options;

  async function loadBook(
    executor: Executor,
    accountingBookId: string,
  ): Promise<AccountingBookRow> {
    const row = await executor.query.accountingBooks.findFirst({
      where: (table, { eq }) => eq(table.id, accountingBookId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown accounting book "${accountingBookId}"`,
      );
    }
    return row;
  }

  async function loadLink(
    executor: Executor,
    bookEntityLinkId: string,
  ): Promise<BookEntityLinkRow> {
    const row = await executor.query.bookEntityLinks.findFirst({
      where: (table, { eq }) => eq(table.id, bookEntityLinkId),
    });
    if (row === undefined) {
      throw new AccountingNotFoundError(
        `unknown book/entity link "${bookEntityLinkId}"`,
      );
    }
    return row;
  }

  /**
   * The routing walk: the entity itself, then its ancestors, nearest first.
   *
   * The depth bound is not paranoia about deep hierarchies — three levels is a
   * lot — it is a cycle guard. `economic_entities.parent_entity_id` is a plain
   * self-reference with no constraint preventing A → B → A, and a recursive CTE
   * that meets one never terminates.
   */
  async function routeThroughEntity(
    executor: Executor,
    economicEntityId: string,
    onDate: string,
  ): Promise<{ accountingBookId: string; depth: number; entityId: string } | null> {
    const result = await executor.execute(
      `with recursive chain as (
         select id, parent_entity_id, 0 as depth
           from economic_entities where id = ${uuidLiteral(economicEntityId)}
         union all
         select parent.id, parent.parent_entity_id, chain.depth + 1
           from economic_entities parent
           join chain on parent.id = chain.parent_entity_id
          where chain.depth < 32
       )
       select chain.depth::text as depth,
              chain.id::text as entity_id,
              link.accounting_book_id::text as accounting_book_id
         from chain
         join book_entity_links link
           on link.economic_entity_id = chain.id
          and link.link_role = 'posting_primary'
          and link.effective_from <= ${dateLiteral(onDate)}
          and (link.effective_to is null or link.effective_to >= ${dateLiteral(onDate)})
        order by chain.depth
        limit 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      accountingBookId: row["accounting_book_id"] as string,
      depth: Number(row["depth"]),
      entityId: row["entity_id"] as string,
    };
  }

  /**
   * The roll-up rule, enforced downward: no descendant of this entity may post
   * to a different book while this link is in force.
   *
   * Enforcing only the upward direction would let an operator link the parent
   * after the child and end up with exactly the split the owner's answer
   * forbids, with no error anywhere.
   */
  async function conflictingDescendantLink(
    executor: Executor,
    economicEntityId: string,
    accountingBookId: string,
    effectiveFrom: string,
    effectiveTo: string | null,
  ): Promise<{ entityName: string; bookCode: string } | null> {
    const upper =
      effectiveTo === null ? "'infinity'::date" : dateLiteral(effectiveTo);
    const result = await executor.execute(
      `with recursive descendants as (
         select id from economic_entities
          where parent_entity_id = ${uuidLiteral(economicEntityId)}
         union all
         select child.id from economic_entities child
           join descendants on child.parent_entity_id = descendants.id
       )
       select entity.name as entity_name, book.code as book_code
         from book_entity_links link
         join descendants on descendants.id = link.economic_entity_id
         join economic_entities entity on entity.id = link.economic_entity_id
         join accounting_books book on book.id = link.accounting_book_id
        where link.link_role = 'posting_primary'
          and link.accounting_book_id <> ${uuidLiteral(accountingBookId)}
          and daterange(link.effective_from,
                        coalesce(link.effective_to, 'infinity'::date), '[]')
              && daterange(${dateLiteral(effectiveFrom)}, ${upper}, '[]')
        limit 1`,
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      entityName: row["entity_name"] as string,
      bookCode: row["book_code"] as string,
    };
  }

  async function resolveBookForEntity(input: {
    economicEntityId?: string | null;
    onDate: string;
    installationDefaultBookId?: string | null;
  }): Promise<BookRouting | null> {
    if (
      input.economicEntityId !== undefined &&
      input.economicEntityId !== null
    ) {
      const route = await routeThroughEntity(
        db,
        input.economicEntityId,
        input.onDate,
      );
      if (route !== null) {
        return {
          accountingBookId: route.accountingBookId,
          source: route.depth === 0 ? "entity_link" : "parent_entity_link",
          viaEconomicEntityId: route.depth === 0 ? null : route.entityId,
        };
      }
    }
    if (
      input.installationDefaultBookId !== undefined &&
      input.installationDefaultBookId !== null
    ) {
      return {
        accountingBookId: input.installationDefaultBookId,
        source: "installation_default",
        viaEconomicEntityId: null,
      };
    }
    return null;
  }

  return {
    createBook: async (input) => {
      const value = parse(createBookSchema, input);
      const functionalCurrency = assertSupportedCurrency(
        value.functionalCurrency ?? DEFAULT_FUNCTIONAL_CURRENCY,
        `cannot create book "${value.code}"`,
      );

      const book = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(accountingBooks)
          .values({
            code: value.code,
            name: value.name,
            functionalCurrency,
            accountingBasis: value.accountingBasis,
            fiscalYearStartMonth: value.fiscalYearStartMonth,
            fiscalYearStartDay: value.fiscalYearStartDay,
            requiresEntityDimension: value.requiresEntityDimension,
            openedOn: value.openedOn,
            notes: value.notes ?? null,
            createdByUserId: value.createdByUserId ?? null,
          })
          .returning();
        const row = inserted[0];
        if (row === undefined) {
          throw new AccountingConflictError(
            "accounting_books insert returned no row",
          );
        }
        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action: "accounting.book.created",
          resourceType: "accounting_book",
          resourceId: row.id,
          after: {
            code: row.code,
            name: row.name,
            functionalCurrency: row.functionalCurrency,
            accountingBasis: row.accountingBasis,
            fiscalYearStartMonth: row.fiscalYearStartMonth,
            fiscalYearStartDay: row.fiscalYearStartDay,
            requiresEntityDimension: row.requiresEntityDimension,
            openedOn: row.openedOn,
          },
          requestId: value.requestId ?? null,
        });
        return row;
      });

      // The chart and the first fiscal year are separate transactions on
      // purpose: each is independently idempotent, and a failure while seeding
      // twenty accounts should leave a usable book rather than no book.
      let accountCount = 0;
      if (value.seedChart) {
        const accounts = await createAccountsService({ db }).seedDefaultChart({
          accountingBookId: book.id,
          ...(input.template === undefined ? {} : { template: input.template }),
          actorUserId: value.createdByUserId ?? null,
          requestId: value.requestId ?? null,
        });
        accountCount = accounts.length;
      }

      let periodCount = 0;
      if (value.generatePeriods) {
        const generated = await createFiscalPeriodsService({
          db,
        }).generateFiscalYear({
          accountingBookId: book.id,
          fiscalYear: fiscalYearFor(
            book.openedOn,
            book.fiscalYearStartMonth,
            book.fiscalYearStartDay,
          ),
          actorUserId: value.createdByUserId ?? null,
          requestId: value.requestId ?? null,
        });
        periodCount = generated.periods.length;
      }

      return { book, accountCount, periodCount };
    },

    getBook: async (accountingBookId) => loadBook(db, accountingBookId),

    findBookByCode: async (code) => {
      const row = await db.query.accountingBooks.findFirst({
        where: (table, { eq }) => eq(table.code, code),
      });
      return row ?? null;
    },

    listBooks: async (listOptions) =>
      db.query.accountingBooks.findMany({
        where: (table, { eq }) =>
          listOptions?.includeArchived === true
            ? undefined
            : eq(table.status, "active"),
        orderBy: (table, { asc }) => [asc(table.code)],
      }),

    archiveBook: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadBook(tx, input.accountingBookId);
        if (before.status === "archived") return before;
        await tx.execute(
          `update accounting_books set status = 'archived', updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadBook(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.book.archived",
          resourceType: "accounting_book",
          resourceId: before.id,
          before: { status: before.status },
          after: { status: after.status },
          requestId: input.requestId ?? null,
          metadata: { code: before.code },
        });
        return after;
      }),

    linkEntity: async (input) => {
      const value = parse(linkEntitySchema, input);
      const effectiveTo = value.effectiveTo ?? null;
      if (effectiveTo !== null && effectiveTo < value.effectiveFrom) {
        throw new AccountingValidationError(
          `effectiveTo ${effectiveTo} precedes effectiveFrom ${value.effectiveFrom}`,
        );
      }

      return db.transaction(async (tx) => {
        const book = await loadBook(tx, value.accountingBookId);
        if (book.status !== "active") {
          throw new AccountingValidationError(
            `book ${book.code} is archived and cannot receive new entity links`,
          );
        }
        const entity = await tx.query.economicEntities.findFirst({
          where: (table, { eq }) => eq(table.id, value.economicEntityId),
        });
        if (entity === undefined) {
          throw new AccountingNotFoundError(
            `unknown economic entity "${value.economicEntityId}"`,
          );
        }

        if (value.linkRole === "posting_primary") {
          // Upward: a child's posting book IS its parent's book.
          if (entity.parentEntityId !== null) {
            const parentRoute = await routeThroughEntity(
              tx,
              entity.parentEntityId,
              value.effectiveFrom,
            );
            if (
              parentRoute !== null &&
              parentRoute.accountingBookId !== value.accountingBookId
            ) {
              const parentBook = await loadBook(
                tx,
                parentRoute.accountingBookId,
              );
              throw new AccountingValidationError(
                `"${entity.name}" is part of another economic entity whose ` +
                  `postings go to book ${parentBook.code}, so its own ` +
                  `postings cannot go to ${book.code}. A child entity's ` +
                  "posting_primary book IS its parent's book (owner answer 1): " +
                  "an assumed name's activity is viewable on its own, and its " +
                  "totals land in the parent company's book. Record the " +
                  `separate view as a reporting_only link to ${book.code}, or ` +
                  "detach the entity from its parent if it is genuinely its " +
                  "own accounting subject.",
              );
            }
          }

          // Downward: no descendant may already post somewhere else.
          const descendant = await conflictingDescendantLink(
            tx,
            value.economicEntityId,
            value.accountingBookId,
            value.effectiveFrom,
            effectiveTo,
          );
          if (descendant !== null) {
            throw new AccountingValidationError(
              `"${entity.name}" cannot post to book ${book.code} while its ` +
                `part "${descendant.entityName}" posts to ` +
                `${descendant.bookCode} over the same dates. Roll-up requires ` +
                "one book for an entity and everything included in it; move " +
                "the child link first, or make it reporting_only.",
            );
          }
        }

        let inserted;
        try {
          inserted = await tx
            .insert(bookEntityLinks)
            .values({
              accountingBookId: value.accountingBookId,
              economicEntityId: value.economicEntityId,
              linkRole: value.linkRole,
              effectiveFrom: value.effectiveFrom,
              effectiveTo,
              dimensionLabel: value.dimensionLabel ?? null,
              note: value.note ?? null,
              createdByUserId: value.createdByUserId ?? null,
            })
            .returning();
        } catch (error) {
          if (isExclusionViolation(error)) {
            throw new AccountingConflictError(
              `"${entity.name}" already has a posting_primary book over dates ` +
                `overlapping ${value.effectiveFrom}..${effectiveTo ?? "open"}. ` +
                "At most one primary book per entity per day is what makes " +
                "routing deterministic; close the existing link with an " +
                "effectiveTo before opening the next one, which is how an " +
                "entity moves books at a date boundary without rewriting " +
                "history.",
            );
          }
          throw error;
        }
        const row = inserted[0];
        if (row === undefined) {
          throw new AccountingConflictError(
            "book_entity_links insert returned no row",
          );
        }

        await createAuditService({ db: tx }).append({
          actorUserId: value.createdByUserId ?? null,
          action: "accounting.book.entity_linked",
          resourceType: "accounting_book",
          resourceId: value.accountingBookId,
          after: {
            bookEntityLinkId: row.id,
            economicEntityId: row.economicEntityId,
            linkRole: row.linkRole,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
          },
          requestId: value.requestId ?? null,
          metadata: { bookCode: book.code, entityName: entity.name },
        });
        return row;
      });
    },

    endLink: async (input) =>
      db.transaction(async (tx) => {
        const before = await loadLink(tx, input.bookEntityLinkId);
        if (input.effectiveTo < before.effectiveFrom) {
          throw new AccountingValidationError(
            `effectiveTo ${input.effectiveTo} precedes the link's ` +
              `effectiveFrom ${before.effectiveFrom}`,
          );
        }
        await tx.execute(
          `update book_entity_links
              set effective_to = ${dateLiteral(input.effectiveTo)},
                  updated_at = now()
            where id = ${uuidLiteral(before.id)}`,
        );
        const after = await loadLink(tx, before.id);
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "accounting.book.entity_link_ended",
          resourceType: "accounting_book",
          resourceId: before.accountingBookId,
          before: { effectiveTo: before.effectiveTo },
          after: { effectiveTo: after.effectiveTo },
          requestId: input.requestId ?? null,
          metadata: {
            bookEntityLinkId: before.id,
            economicEntityId: before.economicEntityId,
            linkRole: before.linkRole,
          },
        });
        return after;
      }),

    listLinks: async (listOptions) => {
      const predicates: string[] = [];
      if (listOptions.accountingBookId !== undefined) {
        predicates.push(
          `accounting_book_id = ${uuidLiteral(listOptions.accountingBookId)}`,
        );
      }
      if (listOptions.economicEntityId !== undefined) {
        predicates.push(
          `economic_entity_id = ${uuidLiteral(listOptions.economicEntityId)}`,
        );
      }
      if (listOptions.onDate !== undefined) {
        predicates.push(
          `effective_from <= ${dateLiteral(listOptions.onDate)}`,
          `(effective_to is null or effective_to >= ${dateLiteral(listOptions.onDate)})`,
        );
      }
      const where =
        predicates.length === 0 ? "" : `where ${predicates.join(" and ")}`;
      const result = await db.execute(
        `select id::text as id from book_entity_links ${where}
          order by effective_from, link_role`,
      );
      const ids = result.rows.map((row) => row["id"] as string);
      if (ids.length === 0) return [];
      const rows = await db.query.bookEntityLinks.findMany({
        where: (table, { inArray }) => inArray(table.id, ids),
        orderBy: (table, { asc }) => [asc(table.effectiveFrom), asc(table.linkRole)],
      });
      return rows;
    },

    resolveBookForEntity,

    requireBookForEntity: async (input) => {
      const routing = await resolveBookForEntity(input);
      if (routing !== null) return routing;
      throw new BookRoutingError(
        input.economicEntityId === undefined || input.economicEntityId === null
          ? `no book could be resolved for a fact on ${input.onDate}: it ` +
            "carries no economic entity and no installation default book is " +
            "configured. This is the unpostable backlog, not an error to " +
            "retry — the fact's accounting ownership has not been stated, and " +
            "guessing it silently is how a ledger stops being trustworthy."
          : `no book could be resolved for economic entity ` +
            `"${input.economicEntityId}" on ${input.onDate}: neither it nor ` +
            "any entity it is part of has a posting_primary link covering " +
            "that date, and no installation default book is configured. Link " +
            "the entity (or its parent) to a book, then re-run; until then " +
            "the fact belongs in the unpostable backlog.",
      );
    },
  };
}

/** The `application_settings` key an installation default book is configured under. */
export const DEFAULT_BOOK_SETTING_KEY = "accounting.default_book_id";

/**
 * PROVISIONAL: the key is NAMED here and deliberately not registered in
 * `@loxep/domain`'s settings registry.
 *
 * Registration is an edit to a package this slice does not own, and the same
 * call was made one milestone earlier for `accounting.default_economic_entity`.
 * The installation default is a parameter to {@link BooksService.resolveBookForEntity}
 * instead, and the signature does not change when the key is registered.
 */
export const ACCOUNTING_SETTING_KEYS = [
  DEFAULT_BOOK_SETTING_KEY,
  "accounting.default_entity_id",
  "accounting.auto_post_enabled",
  "accounting.posting_lag_days",
] as const;
