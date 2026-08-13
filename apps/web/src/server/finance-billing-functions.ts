/**
 * Server functions for the /finance on-demand Invoice Ninja draft-invoice
 * push (loxep-v5r.5).
 *
 * `apps/web/package.json` now declares both `@loxep/integration-invoiceninja`
 * and `@loxep/work` (added after this file first shipped with the two calls
 * blocked — see git history / the schema design doc's implementation record
 * for that earlier state), so every function below is real end to end:
 *
 * - `listInvoiceNinjaConnections`, `searchCounterpartiesForBilling`, and
 *   `checkDraftInvoicePushStatus` read `connections`/`counterparties`/the
 *   `external_resources`+`resource_links` idempotency guard straight out of
 *   PostgreSQL via `@loxep/db`, exactly like every other reader in
 *   `admin-functions.ts`.
 * - `pushDraftInvoice` resolves the connection's `invoiceninja_credentials`
 *   bundle and its non-secret `config.invoiceninja.baseUrl`, builds a real
 *   `InvoiceNinjaAdapter`, reuses an existing `purpose='billing_client'` link
 *   when one exists (never re-creates a client it already pushed), creates
 *   the client/invoice via `@loxep/integration-invoiceninja`'s `createClient`/
 *   `createInvoice`, and persists both linkage rows.
 * - `listUnbilledWorkForBilling` reads `@loxep/work`'s unbilled-work model
 *   (time entries + material uses) for the push dialog's optional "load
 *   unbilled work" action. It uses `alwaysUnbilledResolver` (the package's
 *   own honest default) because `invoice_line_sources` — the table a real
 *   billed-status resolver would query — does not exist yet; see that
 *   package's `unbilled.ts` module doc.
 *
 * The idempotency guard's own honest limit is unchanged by any of this: it
 * is scoped per-project (or per-counterparty with no project), not
 * per-source-fact, because `invoice_line_sources` (the table that would let
 * it check exactly which facts a draft already covers) is design-only. A
 * second push for an already-linked target is refused outright, even if new
 * unbilled work has since accrued — see `finance-billing.ts`'s module doc.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { LoxepDb } from '@loxep/db';
import {
  BILLING_CLIENT_PURPOSE,
  BILLING_DRAFT_PUSH_PURPOSE,
  INVOICENINJA_PROVIDER,
  buildDraftInvoiceLinkage,
  buildNinjaClientLinkage,
  composeDraftInvoicePush,
  resolveBillingLinkTarget,
  validateDraftInvoiceLines,
  type DraftInvoicePushDeps,
  type LinkageRows
} from '@/server/finance-billing';

const draftInvoiceLineInput = z.strictObject({
  description: z.string().trim().min(1),
  /** Decimal string, e.g. "2.5". */
  quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
  /** Decimal string — the unit price. */
  unitCost: z.string().regex(/^\d+(\.\d{1,6})?$/)
});

const pushDraftInvoiceInput = z.strictObject({
  counterpartyId: z.uuid(),
  projectId: z.uuid().nullish(),
  connectionId: z.uuid(),
  lines: z.array(draftInvoiceLineInput).min(1)
});

// ---------------------------------------------------------------------------
// Connection + counterparty pickers (real)
// ---------------------------------------------------------------------------

export interface InvoiceNinjaConnectionOptionDto {
  id: string;
  name: string;
  status: string;
  externalAccountName: string | null;
}

/** Every `provider='invoiceninja'` connection, for the push dialog's connection picker (member-readable, no secrets). */
export const listInvoiceNinjaConnections = createServerFn({ method: 'GET' }).handler(
  async (): Promise<InvoiceNinjaConnectionOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const rows = await getAdminServices().connections.listConnections({ provider: 'invoiceninja' });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      externalAccountName: row.externalAccountName
    }));
  }
);

export interface CounterpartyBillingOptionDto {
  id: string;
  displayName: string;
  referenceCode: string;
}

/**
 * Small contains-match search over `counterparties` (display name or
 * reference code), archived rows excluded — no full-text search, this is a
 * picker convenience, not the duplicate-candidate report the design's own
 * merge tooling would need.
 */
export const searchCounterpartiesForBilling = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ query: z.string().trim() }))
  .handler(async ({ data }): Promise<CounterpartyBillingOptionDto[]> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const term = data.query;
    const rows = await getAdminServices().handle.db.query.counterparties.findMany({
      where: (table, { and, ilike, ne, or }) =>
        term === ''
          ? ne(table.status, 'archived')
          : and(
              ne(table.status, 'archived'),
              or(ilike(table.displayName, `%${term}%`), ilike(table.referenceCode, `%${term}%`))
            ),
      orderBy: (table, { asc }) => asc(table.displayName),
      limit: 10
    });
    return rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      referenceCode: row.referenceCode
    }));
  });

// ---------------------------------------------------------------------------
// resource_links lookups + persistence (real)
// ---------------------------------------------------------------------------

interface ResourceLinkRecord {
  externalId: string;
  url: string;
  title: string | null;
  linkedAt: string;
}

/**
 * The generic "does a `provider='invoiceninja'` link with this purpose/
 * target already exist" read, shared by the draft-push idempotency guard
 * and the client-projection reuse check.
 */
async function findExistingResourceLink(
  db: LoxepDb,
  target: { purpose: string; resourceType: string; resourceId: string }
): Promise<ResourceLinkRecord | null> {
  const link = await db.query.resourceLinks.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.purpose, target.purpose),
        eq(table.resourceType, target.resourceType),
        eq(table.resourceId, target.resourceId)
      )
  });
  if (link === undefined) return null;

  const resource = await db.query.externalResources.findFirst({
    where: (table, { eq }) => eq(table.id, link.externalResourceId)
  });
  if (resource === undefined || resource.provider !== INVOICENINJA_PROVIDER) return null;

  return {
    externalId: resource.externalId ?? '',
    url: resource.url,
    title: resource.title,
    linkedAt: link.createdAt.toISOString()
  };
}

/**
 * Persists one `external_resources` row plus its `resource_links` row.
 * `onConflictDoNothing` targets the unique constraint the design's
 * idempotency guard depends on (migration `0004_link_table_constraints.sql`
 * / `loxep-dyx`) — an at-least-once retry of this action can never double
 * the link, only the (harmless, never-read-back) `external_resources` row it
 * points at.
 */
async function persistResourceLink(db: LoxepDb, rows: LinkageRows): Promise<void> {
  const { externalResources, resourceLinks } = await import('@loxep/db/schema');
  const inserted = await db.insert(externalResources).values(rows.resource).returning({
    id: externalResources.id
  });
  const externalResourceId = inserted[0]?.id;
  if (externalResourceId === undefined) {
    throw new Error('external_resources insert returned no row');
  }
  await db
    .insert(resourceLinks)
    .values({ externalResourceId, ...rows.link })
    .onConflictDoNothing({
      target: [
        resourceLinks.externalResourceId,
        resourceLinks.resourceType,
        resourceLinks.resourceId,
        resourceLinks.purpose
      ]
    });
}

export interface ExistingDraftPushDto {
  externalInvoiceId: string;
  url: string;
  /** The Ninja-assigned number when known, else the placeholder title recorded at push time. */
  title: string | null;
  linkedAt: string;
}

/**
 * "Has this project (or counterparty, with no project) already got an open
 * Invoice Ninja draft push" — the design's own idempotency test, answered by
 * ROW PRESENCE in `resource_links`, never a boolean flag. See
 * `finance-billing.ts`'s module doc for the honest scope limit (per-project,
 * not per-source-fact).
 */
async function findExistingDraftPush(
  db: LoxepDb,
  target: { resourceType: string; resourceId: string }
): Promise<ExistingDraftPushDto | null> {
  const link = await findExistingResourceLink(db, {
    purpose: BILLING_DRAFT_PUSH_PURPOSE,
    ...target
  });
  return link === null
    ? null
    : {
        externalInvoiceId: link.externalId,
        url: link.url,
        title: link.title,
        linkedAt: link.linkedAt
      };
}

export const checkDraftInvoicePushStatus = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ counterpartyId: z.uuid(), projectId: z.uuid().nullish() }))
  .handler(async ({ data }): Promise<ExistingDraftPushDto | null> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const target = resolveBillingLinkTarget({
      counterpartyId: data.counterpartyId,
      projectId: data.projectId ?? null
    });
    return findExistingDraftPush(getAdminServices().handle.db, target);
  });

// ---------------------------------------------------------------------------
// Unbilled-work picker (real, optional — @loxep/work)
// ---------------------------------------------------------------------------

export interface UnbilledWorkLineDto {
  sourceFactType: 'time_entry' | 'project_material_use';
  sourceFactId: string;
  description: string;
  /** Decimal string. */
  quantity: string;
  /** Decimal string — the unit price, `null` when the fact has nothing to compute one from (see `@loxep/work`'s honest-gap rule). */
  unitCost: string | null;
  currency: string | null;
}

/**
 * Time entries and material uses not yet linked to a draft push, for the
 * push dialog's "load unbilled work" action. Uses
 * `alwaysUnbilledResolver` — the honest default `@loxep/work` ships, since
 * `invoice_line_sources` (the table a real billed-status check would query)
 * does not exist. A row this returns may therefore already be covered by an
 * OPEN draft push this same milestone's idempotency guard would refuse a
 * second push for; the dialog surfaces that guard separately rather than
 * trying to reconcile the two here.
 */
export const listUnbilledWorkForBilling = createServerFn({ method: 'GET' })
  .inputValidator(z.strictObject({ counterpartyId: z.uuid(), projectId: z.uuid().nullish() }))
  .handler(async ({ data }): Promise<UnbilledWorkLineDto[]> => {
    const [{ requireSession, getAdminServices }, work] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/work')
    ]);
    await requireSession();
    const { handle } = getAdminServices();
    const service = work.createUnbilledWorkService({ db: handle.db });
    const filter = { counterpartyId: data.counterpartyId, projectId: data.projectId ?? undefined };

    const [time, materials] = await Promise.all([
      service.listUnbilledTime(filter),
      service.listUnbilledMaterials(filter)
    ]);

    return [
      ...time.map((entry): UnbilledWorkLineDto => ({
        sourceFactType: 'time_entry',
        sourceFactId: entry.id,
        description: entry.description ?? `${entry.workedByLabel} — ${entry.workedOn}`,
        quantity: (entry.billableMinutes / 60).toFixed(6),
        unitCost: entry.billRateAmount,
        currency: entry.currency
      })),
      ...materials.map((use): UnbilledWorkLineDto => ({
        sourceFactType: 'project_material_use',
        sourceFactId: use.id,
        description: use.description,
        quantity: use.quantity,
        unitCost: use.unitChargeAmount,
        currency: use.currency
      }))
    ];
  });

// ---------------------------------------------------------------------------
// The push itself
// ---------------------------------------------------------------------------

export interface PushDraftInvoiceResultDto {
  /** `true` when an existing draft push was found and reused instead of creating a new one. */
  alreadyPushed: boolean;
  externalInvoiceId: string;
  url: string;
  number: string | null;
}

export const pushDraftInvoice = createServerFn({ method: 'POST' })
  .inputValidator(pushDraftInvoiceInput)
  .handler(async ({ data }): Promise<PushDraftInvoiceResultDto> => {
    const [{ requireAdmin, getAdminServices }, ninja] = await Promise.all([
      import('@/server/admin'),
      import('@loxep/integration-invoiceninja')
    ]);
    await requireAdmin();
    const { handle, connections } = getAdminServices();
    const projectId = data.projectId ?? null;

    const counterparty = await handle.db.query.counterparties.findFirst({
      where: (table, { eq }) => eq(table.id, data.counterpartyId)
    });
    if (counterparty === undefined) {
      throw new Error(`unknown counterparty "${data.counterpartyId}"`);
    }

    let projectReferenceCode: string | null = null;
    if (projectId !== null) {
      const project = await handle.db.query.projects.findFirst({
        where: (table, { eq }) => eq(table.id, projectId)
      });
      if (project === undefined) {
        throw new Error(`unknown project "${projectId}"`);
      }
      if (project.counterpartyId !== data.counterpartyId) {
        throw new Error(
          `project "${projectId}" does not belong to counterparty "${data.counterpartyId}"`
        );
      }
      projectReferenceCode = project.referenceCode;
    }

    const connection = await connections.getConnection(data.connectionId);
    if (connection.provider !== 'invoiceninja') {
      throw new Error(`connection "${data.connectionId}" is not an Invoice Ninja connection`);
    }

    const target = resolveBillingLinkTarget({ counterpartyId: data.counterpartyId, projectId });
    const existing = await findExistingDraftPush(handle.db, target);
    if (existing !== null) {
      return {
        alreadyPushed: true,
        externalInvoiceId: existing.externalInvoiceId,
        url: existing.url,
        number: existing.title
      };
    }

    validateDraftInvoiceLines(data.lines);

    const credential = await connections.getConnectionCredentialPayload(
      connection.id,
      'invoiceninja_credentials'
    );
    const invoiceNinjaConfig = connection.config['invoiceninja'] as
      | { baseUrl?: string }
      | undefined;
    const baseUrl = invoiceNinjaConfig?.baseUrl;
    if (baseUrl === undefined || baseUrl === '') {
      throw new Error(`connection "${connection.id}" has no invoiceninja.baseUrl configured`);
    }
    const adapter = ninja.createInvoiceNinjaAdapter({
      baseUrl,
      apiToken: credential.payload.apiToken
    });

    const deps: DraftInvoicePushDeps = {
      ensureNinjaClient: async ({ displayName }) => {
        const existingClient = await findExistingResourceLink(handle.db, {
          purpose: BILLING_CLIENT_PURPOSE,
          resourceType: 'counterparty',
          resourceId: counterparty.id
        });
        if (existingClient !== null) {
          return { externalClientId: existingClient.externalId, url: existingClient.url };
        }

        const created = await ninja.createClient(adapter, { name: displayName });
        // Invoice Ninja's admin UI client route — a best-effort link for the
        // linkage row's `url`, not independently live-confirmed (no write
        // credential existed when the adapter was built; see its module doc).
        const url = `${adapter.baseUrl}/clients/${created.externalClientId}`;
        await persistResourceLink(
          handle.db,
          buildNinjaClientLinkage({
            connectionId: connection.id,
            counterpartyId: counterparty.id,
            externalClientId: created.externalClientId,
            url,
            displayName
          })
        );
        return { externalClientId: created.externalClientId, url };
      },
      createDraftInvoiceOnNinja: async ({ externalClientId, poNumber, lines }) => {
        const invoice = await ninja.createInvoice(adapter, {
          externalClientId,
          ...(poNumber !== null ? { poNumber } : {}),
          lineItems: lines.map((line) => ({
            quantity: line.quantity,
            cost: line.unitCost,
            notes: line.description
          }))
        });
        return {
          externalInvoiceId: invoice.externalInvoiceId,
          // Same best-effort-UI-link caveat as the client url above.
          url: `${adapter.baseUrl}/invoices/${invoice.externalInvoiceId}`,
          number: invoice.number
        };
      }
    };

    const result = await composeDraftInvoicePush(
      {
        counterpartyId: counterparty.id,
        counterpartyDisplayName: counterparty.displayName,
        counterpartyReferenceCode: counterparty.referenceCode,
        projectId,
        projectReferenceCode,
        lines: data.lines
      },
      deps
    );

    await persistResourceLink(
      handle.db,
      buildDraftInvoiceLinkage({
        connectionId: connection.id,
        counterpartyId: counterparty.id,
        projectId,
        externalInvoiceId: result.invoice.externalInvoiceId,
        url: result.invoice.url,
        number: result.invoice.number
      })
    );

    return {
      alreadyPushed: false,
      externalInvoiceId: result.invoice.externalInvoiceId,
      url: result.invoice.url,
      number: result.invoice.number
    };
  });
