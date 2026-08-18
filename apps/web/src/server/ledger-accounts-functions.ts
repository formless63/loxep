/**
 * Server functions for the Accounts section on `/finance/books/$id`
 * (loxep-l49): the per-book chart of accounts, visible until now only as the
 * trial balance's account column.
 *
 * Sits directly over `@loxep/accounting/chart.ts`'s `AccountsService` — the
 * same "service shipped complete with zero callers" situation
 * `books-functions.ts` documents for `books.ts`/`periods.ts`.
 * `createAccount`/`updateAccount`/`archiveAccount`/`reactivateAccount` are
 * every mutating verb the service exports; nothing here invents a rename of
 * `accountType` or `systemKey` (the service refuses both — see `chart.ts`'s
 * own doc on what an operator may never change) and nothing here lets an
 * operator ASSIGN a `systemKey` through this dialog — that handle is what
 * every shipped posting rule resolves through, and an operator-typed one
 * with no rule behind it is a silent suspense trap waiting to happen.
 * Accounts created here are always plain (`systemKey: null`).
 *
 * Role gate, per ADR-0017 and matching `books-functions.ts`'s own split:
 * `fetchLedgerAccounts` is `requireSession` (ordinary product data, same as
 * the trial balance); every write is `requireAdmin` (an edit to the chart of
 * accounts is administrative, same standing as linking an entity or closing
 * a period).
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const LEDGER_ACCOUNT_TYPE_VALUES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export interface LedgerAccountDto {
  id: string;
  code: string;
  name: string;
  accountType: string;
  accountSubtype: string | null;
  systemKey: string | null;
  parentAccountId: string | null;
  isPostable: boolean;
  isContra: boolean;
  currency: string | null;
  status: string;
  description: string | null;
}

function toDto(row: {
  id: string;
  code: string;
  name: string;
  accountType: string;
  accountSubtype: string | null;
  systemKey: string | null;
  parentAccountId: string | null;
  isPostable: boolean;
  isContra: boolean;
  currency: string | null;
  status: string;
  description: string | null;
}): LedgerAccountDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.accountType,
    accountSubtype: row.accountSubtype,
    systemKey: row.systemKey,
    parentAccountId: row.parentAccountId,
    isPostable: row.isPostable,
    isContra: row.isContra,
    currency: row.currency,
    status: row.status,
    description: row.description
  };
}

export const fetchLedgerAccounts = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ accountingBookId: z.uuid() }))
  .handler(async ({ data }): Promise<LedgerAccountDto[]> => {
    const { requireSession, getAccountsService } = await import('@/server/admin');
    await requireSession();
    const rows = await getAccountsService().listAccounts(data.accountingBookId, {
      includeArchived: true
    });
    return rows.map(toDto);
  });

const createLedgerAccountInput = z.strictObject({
  accountingBookId: z.uuid(),
  code: z.string().trim().min(1),
  name: z.string().trim().min(1),
  accountType: z.enum(LEDGER_ACCOUNT_TYPE_VALUES),
  accountSubtype: z.string().trim().min(1).nullish(),
  parentAccountId: z.uuid().nullish(),
  isPostable: z.boolean().default(true),
  isContra: z.boolean().default(false),
  description: z.string().trim().min(1).nullish()
});

export const createLedgerAccount = createServerFn({ method: 'POST' })
  .inputValidator(createLedgerAccountInput)
  .handler(async ({ data }): Promise<LedgerAccountDto> => {
    const { requireAdmin, getAccountsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getAccountsService().createAccount({
      accountingBookId: data.accountingBookId,
      code: data.code,
      name: data.name,
      accountType: data.accountType,
      accountSubtype: data.accountSubtype ?? null,
      // `systemKey` is deliberately never accepted from this input — see the module doc.
      parentAccountId: data.parentAccountId ?? null,
      isPostable: data.isPostable,
      isContra: data.isContra,
      description: data.description ?? null,
      actorUserId: session.user.id
    });
    return toDto(row);
  });

const updateLedgerAccountInput = z.strictObject({
  ledgerAccountId: z.uuid(),
  code: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  accountSubtype: z.string().trim().min(1).nullish(),
  parentAccountId: z.uuid().nullish(),
  isPostable: z.boolean().optional(),
  description: z.string().trim().min(1).nullish()
});

export const updateLedgerAccount = createServerFn({ method: 'POST' })
  .inputValidator(updateLedgerAccountInput)
  .handler(async ({ data }): Promise<LedgerAccountDto> => {
    const { requireAdmin, getAccountsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getAccountsService().updateAccount({
      ledgerAccountId: data.ledgerAccountId,
      code: data.code,
      name: data.name,
      accountSubtype: data.accountSubtype,
      parentAccountId: data.parentAccountId,
      isPostable: data.isPostable,
      description: data.description,
      actorUserId: session.user.id
    });
    return toDto(row);
  });

export const archiveLedgerAccount = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ ledgerAccountId: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireAdmin, getAccountsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getAccountsService().archiveAccount({
      ledgerAccountId: data.ledgerAccountId,
      actorUserId: session.user.id
    });
    return { status: row.status };
  });

export const reactivateLedgerAccount = createServerFn({ method: 'POST' })
  .inputValidator(z.strictObject({ ledgerAccountId: z.uuid() }))
  .handler(async ({ data }): Promise<{ status: string }> => {
    const { requireAdmin, getAccountsService } = await import('@/server/admin');
    const session = await requireAdmin();
    const row = await getAccountsService().reactivateAccount({
      ledgerAccountId: data.ledgerAccountId,
      actorUserId: session.user.id
    });
    return { status: row.status };
  });
