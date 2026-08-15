/**
 * Server functions for counterparties-as-expense-payees (loxep-cd3.1, M1).
 *
 * Design: `apps/docs/src/content/docs/architecture/expense-entry-design.md`
 * section 2 ("Trading partners: counterparties as payees"). "Trading
 * partner" is vocabulary, not a table — a counterparty holding a `vendor` or
 * `payee` relationship row (`counterparty_entity_roles`).
 *
 * ## Why this file talks to `@loxep/db` directly instead of `@loxep/counterparties`
 *
 * `@loxep/counterparties` (the real domain service — `create`, `contacts.
 * addContact`, `roles.grant`, `listByEntityRole`, `listForPicker`,
 * `pickerPredicate`) is NOT wired into `apps/web`: no `apps/web/package.json`
 * dependency exists, and this bead's write fence is `packages/db/**`,
 * `packages/counterparties/**`, `packages/accounting/**` (linkage only),
 * `packages/integrations/invoiceninja/**` (mapping only), and `apps/web/src`
 * — explicitly NOT `package.json`/`bun.lock`. Adding the dependency is
 * therefore out of scope for this bead and is the natural next step for
 * whoever picks up M2/M3 or a dedicated follow-up.
 *
 * This mirrors the exact situation `finance-billing.ts`'s own module doc
 * already documents for `@loxep/integration-invoiceninja`/`@loxep/work`
 * earlier in that issue's history: build the composition against
 * `@loxep/db` (already a real dependency) with the minimum domain logic
 * duplicated and clearly marked, rather than block the milestone on a
 * dependency-wiring pass. Concretely, duplicated here (kept intentionally
 * tiny and pure, matching `@loxep/counterparties/{codes,normalize}.ts`):
 * reference-code generation with unique-violation retry, and a light
 * ILIKE-based search rather than `normalizeName`'s fuller matching
 * normalization (which only matters for the dedupe/duplicate-candidate
 * report this surface does not need). `@loxep/domain`'s `createAuditService`
 * IS used directly below — that package IS a real `apps/web` dependency —
 * so the audit trail this writes matches what the real service would have
 * produced.
 *
 * Every write goes through ONE transaction and stays inside the exact
 * `counterparties` / `counterparty_contacts` / `contact_channels` /
 * `counterparty_entity_roles` shape `@loxep/db/schema/counterparties.ts`
 * defines — the same tables the real service would write, so wiring the
 * real package in later is a pure refactor with no data-shape change.
 *
 * Role gate: `requireSession` (ordinary operator work), matching
 * `expense-functions.ts`. `session.user.id` becomes `created_by_user_id` /
 * the audit actor.
 */
import { createServerFn } from '@tanstack/react-start';
import { createAuditService } from '@loxep/domain';
import {
  contactChannels,
  counterpartyContacts,
  counterpartyEntityRoles,
  counterparties
} from '@loxep/db/schema';
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

/** `CP-2026-0117` — the same shape `@loxep/counterparties/codes.ts` generates. */
function counterpartyReferenceCode(year: number, sequence: number): string {
  return `CP-${year}-${String(sequence).padStart(4, '0')}`;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (code === '23505') return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? false : isUniqueViolation(cause);
}

export const createTradingPartner = createServerFn({ method: 'POST' })
  .inputValidator(createTradingPartnerInput)
  .handler(async ({ data }): Promise<CreateTradingPartnerResultDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    const session = await requireSession();
    const { handle } = getAdminServices();
    const year = new Date().getUTCFullYear();
    const email = data.email ?? null;
    const economicEntityId = data.economicEntityId ?? null;

    const ATTEMPTS = 5;
    let lastError: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      try {
        return await handle.db.transaction(async (tx) => {
          const maxSeq = await tx.execute(
            `select coalesce(max(
                      (substring(reference_code from '^CP-[0-9]{4}-([0-9]+)$'))::integer
                    ), 0)::text as max_seq
               from counterparties
              where reference_code like ${textLiteral(`CP-${year}-%`)}`
          );
          const nextSeq = Number(maxSeq.rows[0]?.['max_seq'] ?? '0') + 1;
          const referenceCode = counterpartyReferenceCode(year, nextSeq);

          const inserted = await tx
            .insert(counterparties)
            .values({
              referenceCode,
              kind: data.kind,
              displayName: data.displayName,
              legalName: data.legalName ?? null,
              // A lightweight fold, not @loxep/counterparties/normalize.ts's
              // fuller legal-suffix/diacritic normalization — see this
              // file's module doc. Good enough to satisfy the NOT NULL
              // column and support a basic search; the dedupe report is not
              // a consumer of anything created through this narrow path.
              normalizedName: (data.legalName ?? data.displayName).trim().toLowerCase(),
              createdByUserId: session.user.id
            })
            .returning();
          const counterparty = inserted[0];
          if (counterparty === undefined) {
            throw new Error('counterparties insert returned no row');
          }

          const audit = createAuditService({ db: tx });
          await audit.append({
            actorUserId: session.user.id,
            action: 'counterparty.created',
            resourceType: 'counterparty',
            resourceId: counterparty.id,
            after: {
              referenceCode: counterparty.referenceCode,
              kind: counterparty.kind,
              displayName: counterparty.displayName,
              status: counterparty.status
            },
            metadata: { source: 'trading-partner-inline-create' }
          });

          if (email !== null) {
            const contactInserted = await tx
              .insert(counterpartyContacts)
              .values({
                counterpartyId: counterparty.id,
                displayName: 'Primary contact',
                isPrimary: true
              })
              .returning();
            const contact = contactInserted[0];
            if (contact === undefined) {
              throw new Error('counterparty_contacts insert returned no row');
            }
            await audit.append({
              actorUserId: session.user.id,
              action: 'counterparty.contact_added',
              resourceType: 'counterparty',
              resourceId: counterparty.id,
              after: { contactId: contact.id, displayName: contact.displayName, isPrimary: true }
            });

            await tx.insert(contactChannels).values({
              counterpartyContactId: contact.id,
              channelKind: 'email',
              value: email,
              normalizedValue: email.toLowerCase(),
              isPrimary: true
            });
            await audit.append({
              actorUserId: session.user.id,
              action: 'counterparty.channel_added',
              resourceType: 'counterparty',
              resourceId: counterparty.id,
              after: { channelKind: 'email', isPrimary: true, counterpartyContactId: contact.id }
            });
          }

          await tx.insert(counterpartyEntityRoles).values({
            counterpartyId: counterparty.id,
            economicEntityId,
            role: data.role,
            status: 'active',
            createdByUserId: session.user.id
          });
          await audit.append({
            actorUserId: session.user.id,
            action: 'counterparty.role_granted',
            resourceType: 'counterparty',
            resourceId: counterparty.id,
            after: { role: data.role, economicEntityId }
          });

          return {
            id: counterparty.id,
            referenceCode: counterparty.referenceCode,
            displayName: counterparty.displayName
          };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        lastError = error;
      }
    }
    throw new Error(
      `could not generate a unique trading-partner reference code after ${ATTEMPTS} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
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
