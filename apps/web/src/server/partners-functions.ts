/**
 * Server functions for `/finance/partners` (loxep-l49): the trading-partner
 * directory — list, create, edit, and role management over
 * `@loxep/counterparties`.
 *
 * ## Why this file calls the real `@loxep/counterparties` service
 *
 * `trading-partner-functions.ts` (loxep-cd3.1) talks to `@loxep/db/schema`
 * directly and duplicates a slice of `@loxep/counterparties`' logic, with a
 * module doc explaining that was because no `apps/web/package.json`
 * dependency on the package existed at the time. That dependency has existed
 * since the SAME commit (loxep-cd3.1 added `"@loxep/counterparties":
 * "workspace:*"` to `apps/web/package.json` — verified against git history
 * and the live symlink in `node_modules/@loxep`), it was simply never
 * consumed anywhere in `apps/web`. This file is the first caller: `@/server/
 * admin`'s `counterparties`/`counterpartyRoles`/`counterpartyContacts`
 * accessors (loxep-l49) wrap `createCounterpartiesService`/
 * `createRolesService`/`createContactsService` directly, so every write here
 * goes through the real validated service — normalization, reference-code
 * generation, the tax-identifier/organization boundary check, and the audit
 * trail all come from the package rather than being re-implemented. This
 * file does not modify `trading-partner-functions.ts`; that surface (the
 * expense payee combobox's inline create) keeps working exactly as it does
 * today and is out of this bead's fence.
 *
 * ## Merge is deliberately absent from this surface
 *
 * `@loxep/counterparties` ships `merge.ts` (survivor pointer, compression,
 * `referencesToMergedRows`), but merging is a picker flow — "which of these
 * two rows survives" — that needs its own UI (search the OTHER counterparty,
 * confirm the direction, show what compresses). Building that picker is out
 * of scope for this pass; the list below simply excludes merged rows (the
 * service's own `list()` default), the same posture every picker in this
 * codebase already takes. Wiring an actual merge affordance is left as
 * explicit follow-up rather than invented here.
 *
 * ## Role gate
 *
 * `requireSession` throughout, matching `trading-partner-functions.ts`'s own
 * precedent: recording a trading partner (like recording an expense) is
 * ordinary operator work, not an administrative act on the ledger the way
 * creating a book or an account is.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const TRADING_PARTNER_ROLES = [
  'customer',
  'vendor',
  'payer',
  'payee',
  'consignor',
  'subcontractor',
  'partner',
  'other'
] as const;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface PartnerListItemDto {
  id: string;
  referenceCode: string;
  kind: string;
  displayName: string;
  legalName: string | null;
  status: string;
  defaultCurrency: string | null;
  /** Every ACTIVE role this party holds, installation-wide or entity-scoped, deduped by name. */
  roles: string[];
  primaryContact: { name: string; email: string | null } | null;
  /** A `resource_links` row exists linking this counterparty to an Invoice Ninja client (`finance-billing.ts`'s `BILLING_CLIENT_PURPOSE`). */
  hasBillingClientLink: boolean;
  createdAt: string;
}

export const fetchPartners = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PartnerListItemDto[]> => {
    const { requireSession, getAdminServices, getCounterpartiesService } =
      await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const { BILLING_CLIENT_PURPOSE } = await import('@/server/finance-billing');

    const counterparties = await getCounterpartiesService().list();
    const ids = counterparties.map((row) => row.id);
    if (ids.length === 0) return [];

    const [roleRows, contactRows, linkRows] = await Promise.all([
      handle.db.query.counterpartyEntityRoles.findMany({
        where: (table, { and, eq, inArray }) =>
          and(inArray(table.counterpartyId, ids), eq(table.status, 'active')),
        columns: { counterpartyId: true, role: true }
      }),
      handle.db.query.counterpartyContacts.findMany({
        where: (table, { and, eq, inArray }) =>
          and(inArray(table.counterpartyId, ids), eq(table.isPrimary, true)),
        columns: { id: true, counterpartyId: true, displayName: true }
      }),
      handle.db.query.resourceLinks.findMany({
        where: (table, { and, eq, inArray }) =>
          and(
            eq(table.resourceType, 'counterparty'),
            eq(table.purpose, BILLING_CLIENT_PURPOSE),
            inArray(table.resourceId, ids)
          ),
        columns: { resourceId: true }
      })
    ]);

    const rolesByCounterparty = new Map<string, Set<string>>();
    for (const row of roleRows) {
      const set = rolesByCounterparty.get(row.counterpartyId) ?? new Set<string>();
      set.add(row.role);
      rolesByCounterparty.set(row.counterpartyId, set);
    }

    const contactIds = contactRows.map((row) => row.id);
    const emailByContact = new Map<string, string>();
    if (contactIds.length > 0) {
      const channels = await handle.db.query.contactChannels.findMany({
        where: (table, { and, eq, inArray }) =>
          and(
            inArray(table.counterpartyContactId, contactIds),
            eq(table.channelKind, 'email'),
            eq(table.isPrimary, true)
          ),
        columns: { counterpartyContactId: true, value: true }
      });
      for (const row of channels) {
        if (row.counterpartyContactId !== null) {
          emailByContact.set(row.counterpartyContactId, row.value);
        }
      }
    }
    const primaryContactByCounterparty = new Map(
      contactRows.map((row) => [
        row.counterpartyId,
        { name: row.displayName, email: emailByContact.get(row.id) ?? null }
      ])
    );

    const billingLinked = new Set(linkRows.map((row) => row.resourceId));

    return counterparties.map((row) => ({
      id: row.id,
      referenceCode: row.referenceCode,
      kind: row.kind,
      displayName: row.displayName,
      legalName: row.legalName,
      status: row.status,
      defaultCurrency: row.defaultCurrency,
      roles: [...(rolesByCounterparty.get(row.id) ?? [])].toSorted(),
      primaryContact: primaryContactByCounterparty.get(row.id) ?? null,
      hasBillingClientLink: billingLinked.has(row.id),
      createdAt: row.createdAt.toISOString()
    }));
  }
);

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

const createPartnerInput = z.strictObject({
  kind: z.enum(['person', 'organization']),
  displayName: z.string().trim().min(1),
  legalName: z.string().trim().min(1).nullish(),
  defaultCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'expected an ISO-4217 alphabetic code')
    .nullish(),
  taxIdentifierKind: z.enum(['vat', 'gst', 'abn', 'ein', 'company_number', 'other']).nullish(),
  taxIdentifier: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
  /** Granted installation-wide (`economicEntityId: null`) — see `updatePartner`'s doc for the scope this dialog manages. */
  roles: z.array(z.enum(TRADING_PARTNER_ROLES)).default([])
});

export interface CreatePartnerResultDto {
  id: string;
  referenceCode: string;
}

export const createPartner = createServerFn({ method: 'POST' })
  .inputValidator(createPartnerInput)
  .handler(async ({ data }): Promise<CreatePartnerResultDto> => {
    const { requireSession, getCounterpartiesService, getCounterpartyRolesService } =
      await import('@/server/admin');
    const session = await requireSession();
    const counterparty = await getCounterpartiesService().create({
      kind: data.kind,
      displayName: data.displayName,
      legalName: data.legalName ?? null,
      defaultCurrency: data.defaultCurrency ?? null,
      taxIdentifierKind: data.taxIdentifierKind ?? null,
      taxIdentifier: data.taxIdentifier ?? null,
      notes: data.notes ?? null,
      createdByUserId: session.user.id
    });
    const rolesService = getCounterpartyRolesService();
    for (const role of data.roles) {
      await rolesService.grant({
        counterpartyId: counterparty.id,
        economicEntityId: null,
        role,
        status: 'active',
        createdByUserId: session.user.id
      });
    }
    return { id: counterparty.id, referenceCode: counterparty.referenceCode };
  });

// ---------------------------------------------------------------------------
// Update — fields, plus installation-wide role reconciliation
// ---------------------------------------------------------------------------

const updatePartnerInput = z.strictObject({
  counterpartyId: z.uuid(),
  displayName: z.string().trim().min(1).optional(),
  legalName: z.string().trim().min(1).nullish(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  defaultCurrency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'expected an ISO-4217 alphabetic code')
    .nullish(),
  taxIdentifierKind: z.enum(['vat', 'gst', 'abn', 'ein', 'company_number', 'other']).nullish(),
  taxIdentifier: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
  /**
   * The FULL desired set of installation-wide roles (`economicEntityId:
   * null`) — reconciled against what already exists: missing ones are
   * granted, present-but-unlisted ones are revoked. An entity-SCOPED role
   * grant (recorded against one economic entity specifically) is invisible
   * to this reconciliation and is never touched by it — this dialog manages
   * only the installation-wide relationship, the same default
   * `trading-partner-functions.ts`'s inline create already uses.
   */
  roles: z.array(z.enum(TRADING_PARTNER_ROLES)).optional()
});

export const updatePartner = createServerFn({ method: 'POST' })
  .inputValidator(updatePartnerInput)
  .handler(async ({ data }): Promise<{ id: string }> => {
    const { requireSession, getCounterpartiesService, getCounterpartyRolesService } =
      await import('@/server/admin');
    const session = await requireSession();
    const updated = await getCounterpartiesService().update({
      counterpartyId: data.counterpartyId,
      displayName: data.displayName,
      legalName: data.legalName,
      status: data.status,
      defaultCurrency: data.defaultCurrency,
      taxIdentifierKind: data.taxIdentifierKind,
      taxIdentifier: data.taxIdentifier,
      notes: data.notes,
      actorUserId: session.user.id
    });

    if (data.roles !== undefined) {
      const rolesService = getCounterpartyRolesService();
      const existing = await rolesService.listForCounterparty(updated.id);
      const activeInstallationWide = existing.filter(
        (row) => row.status === 'active' && row.economicEntityId === null
      );
      const currentRoleNames = new Set(activeInstallationWide.map((row) => row.role));
      const desiredRoleNames = new Set<string>(data.roles);

      for (const role of desiredRoleNames) {
        if (!currentRoleNames.has(role)) {
          await rolesService.grant({
            counterpartyId: updated.id,
            economicEntityId: null,
            role: role as (typeof TRADING_PARTNER_ROLES)[number],
            status: 'active',
            createdByUserId: session.user.id
          });
        }
      }
      for (const row of activeInstallationWide) {
        if (!desiredRoleNames.has(row.role)) {
          await rolesService.revoke({ roleId: row.id, actorUserId: session.user.id });
        }
      }
    }

    return { id: updated.id };
  });
