/**
 * Server functions for counterparties-as-expense-payees (loxep-cd3.1, M1).
 *
 * Design: `apps/docs/src/content/docs/architecture/expense-entry-design.md`
 * section 2 ("Trading partners: counterparties as payees"). "Trading
 * partner" is vocabulary, not a table — a counterparty holding a `vendor` or
 * `payee` relationship row (`counterparty_entity_roles`).
 *
 * ## `createTradingPartner` now routes through the real `@loxep/counterparties` service (loxep-u8c A19)
 *
 * This file originally talked to `@loxep/db` directly and hand-rolled a
 * slice of `@loxep/counterparties`' own logic — reference-code generation,
 * counterparty/contact/channel/role inserts, and a WEAKER `normalizedName`
 * (`.trim().toLowerCase()`, no legal-suffix/diacritic folding) than
 * `normalizeName` produces — because no `apps/web/package.json` dependency
 * on `@loxep/counterparties` existed at the time. That dependency has
 * existed since loxep-cd3.1's own commit (verified against git history and
 * the live symlink in `node_modules/@loxep`) and `@/server/admin`'s
 * `counterparties`/`counterpartyContacts`/`counterpartyRoles` accessors wrap
 * the real `createCounterpartiesService`/`createContactsService`/
 * `createRolesService` (loxep-l49, `partners-functions.ts`). The weaker
 * normalization was a live data-quality leak even though counterparty
 * merge/dedupe stays unbuilt (loxep-u8c's own A19 finding): a row created
 * from THIS inline form would not match a duplicate created through
 * `/finance/partners` once dedupe ships, because `dedupe.ts` groups by
 * `normalized_name` and the two paths were computing two different values
 * for the same input.
 *
 * `createTradingPartner` now calls `CounterpartiesService.create` (which
 * calls `normalizeName` itself and handles reference-code retry via
 * `withCodeRetry`), then `ContactsService.addContact`/`addChannel`, then
 * `RolesService.grant` — the exact sequence the original hand-rolled
 * transaction performed, now delegated to the real, tested, audited
 * services instead of duplicating their logic. This is no longer one atomic
 * transaction (each service call commits its own) — a genuine, small
 * trade-off: a mid-sequence failure (e.g. the role grant failing after the
 * counterparty and contact already committed) leaves a real, findable
 * counterparty with no role yet, rather than nothing at all. That is the
 * same shape every other multi-step domain composition in this app already
 * accepts (e.g. `createStoreConnection` in `admin-functions.ts`, which
 * creates a connection then sets its credential as two separate service
 * calls) and is strictly better than the leak it replaces.
 *
 * `searchTradingPartners` (the picker read) is UNCHANGED — still direct SQL
 * over `@loxep/db`, since it needs no create-path fidelity and
 * `CounterpartiesService` has no picker read shaped exactly like it
 * (`listForPicker` doesn't rank trading-partner roles first the way this
 * search does).
 *
 * Role gate: `requireSession` (ordinary operator work), matching
 * `expense-functions.ts`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const uuidSchema = z.uuid();

function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new Error('expected a UUID value');
  return `'${parsed.data}'`;
}

/** Single-quote-escaped text literal — every value here is operator-typed, never a template fragment. */
function textLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// ---------------------------------------------------------------------------
// Picker search — rolesService.listByEntityRole({role:'vendor'} ∪ {role:'payee'})
// ranked first, then counterpartiesService.listForPicker({search}), per the
// design's "the picker and inline create" section. Merged losers and
// archived parties excluded (the shipped pickerPredicate's rule, reproduced
// here since the function itself is not importable — see this file's doc).
// ---------------------------------------------------------------------------

export interface TradingPartnerOptionDto {
  id: string;
  referenceCode: string;
  displayName: string;
  kind: string;
  /** Holds an active `vendor` or `payee` role against the given entity (or installation-wide). Ranked first. */
  isTradingPartner: boolean;
}

const searchTradingPartnersInput = z.strictObject({
  search: z.string().trim().default(''),
  /** `null`/omitted ranks only installation-wide vendor/payee roles first — matches `listByEntityRole`'s null-entity reading. */
  economicEntityId: z.uuid().nullish()
});

const TRADING_PARTNER_SEARCH_LIMIT = 20;

export const searchTradingPartners = createServerFn({ method: 'GET' })
  .inputValidator(searchTradingPartnersInput)
  .handler(async ({ data }): Promise<TradingPartnerOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const term = data.search.trim();
    const searchPredicate =
      term === ''
        ? 'true'
        : `(c.display_name ilike ${textLiteral(`%${term}%`)} or c.reference_code ilike ${textLiteral(`%${term}%`)})`;
    const entityPredicate =
      data.economicEntityId === undefined || data.economicEntityId === null
        ? 'r.economic_entity_id is null'
        : `(r.economic_entity_id is null or r.economic_entity_id = ${uuidLiteral(data.economicEntityId)})`;
    const result = await handle.db.execute(
      `select c.id::text as id, c.reference_code, c.display_name, c.kind,
              exists (
                select 1 from counterparty_entity_roles r
                 where r.counterparty_id = c.id
                   and r.role in ('vendor', 'payee')
                   and r.status = 'active'
                   and ${entityPredicate}
              ) as is_trading_partner
         from counterparties c
        where c.merged_into_counterparty_id is null
          and c.status <> 'archived'
          and ${searchPredicate}
        order by is_trading_partner desc, c.display_name
        limit ${TRADING_PARTNER_SEARCH_LIMIT}`
    );
    return result.rows.map((row) => ({
      id: row['id'] as string,
      referenceCode: row['reference_code'] as string,
      displayName: row['display_name'] as string,
      kind: row['kind'] as string,
      isTradingPartner: row['is_trading_partner'] as boolean
    }));
  });

// ---------------------------------------------------------------------------
// Inline "+ New trading partner" create — one server function, one
// transaction: counterparties.create -> optional contacts.addContact +
// addChannel(email) -> roles.grant. Default role `payee` (design OQ3).
// ---------------------------------------------------------------------------

const createTradingPartnerInput = z.strictObject({
  kind: z.enum(['person', 'organization']),
  displayName: z.string().trim().min(1),
  legalName: z.string().trim().min(1).nullish(),
  email: z.string().trim().email().nullish(),
  /** `payee` by default — "we paid them" is the fact the expense page is recording; `vendor` is one selector click away. */
  role: z.enum(['vendor', 'payee']).default('payee'),
  /** The expense's entity, or `null` for an installation-wide grant. */
  economicEntityId: z.uuid().nullish()
});

export interface CreateTradingPartnerResultDto {
  id: string;
  referenceCode: string;
  displayName: string;
}

export const createTradingPartner = createServerFn({ method: 'POST' })
  .inputValidator(createTradingPartnerInput)
  .handler(async ({ data }): Promise<CreateTradingPartnerResultDto> => {
    const {
      requireSession,
      getCounterpartiesService,
      getCounterpartyContactsService,
      getCounterpartyRolesService
    } = await import('@/server/admin');
    const session = await requireSession();
    const email = data.email ?? null;
    const economicEntityId = data.economicEntityId ?? null;

    // `CounterpartiesService.create` normalizes through the real
    // `normalizeName` (legal-suffix/diacritic folding) and generates the
    // reference code with its own `withCodeRetry` — both previously
    // duplicated by hand here, the second one more weakly. See the module
    // doc for why this is no longer one atomic transaction.
    const counterparty = await getCounterpartiesService().create({
      kind: data.kind,
      displayName: data.displayName,
      legalName: data.legalName ?? null,
      createdByUserId: session.user.id
    });

    if (email !== null) {
      const contact = await getCounterpartyContactsService().addContact({
        counterpartyId: counterparty.id,
        displayName: 'Primary contact',
        isPrimary: true,
        actorUserId: session.user.id
      });
      await getCounterpartyContactsService().addChannel({
        counterpartyContactId: contact.id,
        channelKind: 'email',
        value: email,
        isPrimary: true,
        actorUserId: session.user.id
      });
    }

    await getCounterpartyRolesService().grant({
      counterpartyId: counterparty.id,
      economicEntityId,
      role: data.role,
      status: 'active',
      createdByUserId: session.user.id
    });

    return {
      id: counterparty.id,
      referenceCode: counterparty.referenceCode,
      displayName: counterparty.displayName
    };
  });

// ---------------------------------------------------------------------------
// "Link this payee" — expense detail, existing expenses (operator-driven
// only). Calls @loxep/accounting's ExpensesService.linkPayee, which snapshots
// the resolved display_name into payee_name in the same write and is the
// ONE field the service will change on a `recorded` expense.
// ---------------------------------------------------------------------------

export const linkExpensePayee = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ expenseId: z.uuid(), payeeCounterpartyId: z.uuid().nullable() }))
  .handler(
    async ({ data }): Promise<{ payeeCounterpartyId: string | null; payeeName: string | null }> => {
      const { requireSession, getExpensesService } = await import('@/server/admin');
      const session = await requireSession();
      const after = await getExpensesService().linkPayee({
        expenseId: data.expenseId,
        payeeCounterpartyId: data.payeeCounterpartyId,
        actorUserId: session.user.id
      });
      return { payeeCounterpartyId: after.payeeCounterpartyId, payeeName: after.payeeName };
    }
  );
