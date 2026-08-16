/**
 * Server functions for the Invoice Ninja estate browser (loxep-47o.8),
 * READ-ONLY. Design:
 * `apps/docs/src/content/docs/architecture/estate-browsers-design.md` §3.9.
 *
 * This is the FIRST estate page outside `/infrastructure` — it proves Rule
 * P1's workspace parameter (the workspace is a property of the PROVIDER, via
 * `@/features/estate/provider-registry`'s `workspace: 'finance'`, never
 * hard-coded into the route or this module). Nothing below imports anything
 * `/infrastructure`-specific; it is built against the exact same shared
 * primitives (`@/features/estate/{types,error-taxonomy}`) every other estate
 * server-function module already uses.
 *
 * ## Sections, and their call cost
 *
 * {@link fetchInvoiceNinjaEstateClients} and
 * {@link fetchInvoiceNinjaEstateInvoices} are the OVERVIEW: each takes a
 * single `page` number and fetches EXACTLY ONE `fetchClientsPage`/
 * `fetchInvoicesPage` call — never more, regardless of what page is asked
 * for. The first render asks for page 1 of each — TWO calls total, exactly
 * Estate Browsers Design §3.9's "Two calls" and comfortably inside Rule P7's
 * three-call ceiling. Invoice Ninja's list endpoints paginate by explicit
 * `page` number (`meta.pagination`), so Rule P8's "Load more" is an
 * OPERATOR-DRIVEN request for exactly the next page, never a server-side
 * re-walk of pages already loaded: `features/finance/estate/components/
 * {clients,invoices}-section.tsx` hold one `useQueries` call per already-
 * requested page number, each independently cached by the query client, and
 * clicking "Load more" adds exactly one new page number to that array — the
 * previously-fetched pages are served from cache, not re-requested. This is
 * the hard numeric guarantee an earlier draft of this module got wrong: a
 * server-side loop from page 1 up to `maxPages` (mirroring
 * `cloudflare-estate-functions.ts`'s cursor-less `maxPages` re-walk) would
 * have cost UP TO 10 sequential calls on one click against this provider's
 * own UNEXPORTED capacity-5, refill-2/s budget (`adapter.ts`'s
 * `DEFAULT_BUDGET`) — enough to drain it and starve a concurrent drill-in.
 * Invoice Ninja's real per-page addressing makes the one-call guarantee
 * possible; `features/finance/estate/lib/combine-paged-estate-section.ts`
 * merges the independently-cached per-page results back into the single
 * `EstateSectionResult` `EstateSection` already knows how to render, so nothing
 * about that shared component changes.
 *
 * {@link fetchInvoiceNinjaEstateClientDetail} and
 * {@link fetchInvoiceNinjaEstateInvoiceDetail} are the per-row DRILL-INS
 * (Rule P6): `fetchClient`/`fetchInvoice`, one row at a time, on explicit
 * expand only, exactly one call each. Each returns strictly MORE than the
 * overview row already carries — the client detail adds `contacts[]` (a
 * potentially long list, deliberately left off the overview row to keep that
 * table compact) and the invoice detail adds `lineItems[]` (never fetched
 * for every row up front) — so the drill-in is never a duplicate read of
 * data the overview already has (Rule P6's own qualifier).
 *
 * ## Cross-reference: the REAL linkage rows the push-draft flow already writes
 *
 * `finance-billing.ts` documents the two `resource_links` purposes the
 * shipped `pushDraftInvoice` flow actually persists today (see that module's
 * own doc for why NEITHER is the design's eventual `purpose=
 * 'delivery_document'`/`resource_type='invoice'` pairing):
 *
 * - `BILLING_CLIENT_PURPOSE` (`'billing_client'`) — `resource_type=
 *   'counterparty'`, written when a client projection is pushed
 *   ({@link invoiceNinjaClientCrossReference}, used by the Clients section).
 * - `BILLING_DRAFT_PUSH_PURPOSE` (`'billing_invoice_draft'`) — `resource_type
 *   in ('project', 'counterparty')`, written when a draft invoice is pushed
 *   ({@link invoiceNinjaInvoiceCrossReference}, used by the Invoices
 *   section).
 *
 * Both cross-references are pure, exported, and unit-tested with fakes (no
 * database, no adapter) — the same shape
 * `dockhandEnvironmentCrossReference`/`cloudflareRecordCrossReference`
 * already established. There is no counterparty detail ROUTE anywhere in
 * this app today (confirmed by search before writing this module), so a
 * "linked" client/invoice row cannot link OUT to a Loxep counterparty page —
 * it renders the counterparty's name/reference code as plain text instead.
 * An invoice row's cross-reference DOES link out, to `/finance/overview`
 * (per this bead's own instruction) — that is where the push dialog and the
 * idempotency guard both already live; this module never re-implements
 * either.
 *
 * ## ZERO write affordances, absolutely
 *
 * This module imports NOTHING from `clients.ts`/`invoices.ts` except
 * `fetchClientsPage`/`fetchClient`/`fetchInvoicesPage`/`fetchInvoice` — never
 * `createClient`, `updateClient`, `createInvoice`, `updateInvoice`, or
 * `markInvoiceSent` (a **GET that mutates** — Estate Browsers Design §3.9's
 * own warning: no "safe GET" assumption may be made anywhere near this
 * provider). `invoiceninja` is absent from `WRITE_POLICY_ENFORCED_PROVIDERS`
 * ([8.4](../../architecture/estate-browsers-design/#84-invoice-ninja-writes-are-ungated-too)
 * of the design), so even if a write verb were reachable here it would have
 * no gate to pass through — this module simply never reaches for one.
 * Pushing a draft stays on `/finance/overview`'s existing dialog; this
 * module (and the components built on it) never imports that dialog.
 *
 * ## Honesty states cross the RPC boundary as DATA, not thrown errors
 *
 * Every classifiable Invoice Ninja failure (the adapter's own five-kind
 * taxonomy, `INVOICENINJA_ERROR_KINDS` — identical set to
 * `@/features/estate/error-taxonomy`'s `ESTATE_ERROR_KINDS`) is caught HERE
 * and returned as an `EstateSectionResult`'s `'error'` branch — never thrown
 * — matching every other estate server-function module's discipline. A
 * connection with no `invoiceninja.baseUrl` configured, or no
 * `invoiceninja_credentials` bundle stored yet, renders Rule P13's BLOCKED
 * state (`resolveInvoiceNinjaAdapter`'s own reason, verbatim) rather than
 * throwing — the same "return the shape and let the page say why" precedent
 * `purelymail-estate-functions.ts` set for its own `orgId === null` case.
 * Only a genuinely unexpected failure (wrong connection provider, a bug)
 * throws.
 *
 * ## Money
 *
 * Every amount below (`balance`, `paidToDate`, `amount`, line `cost`) is
 * carried as the DECIMAL STRING the adapter already produces — never parsed
 * into a JS `number` here, never summed, never compared. Display-only
 * formatting happens client-side via `formatMoney`, which itself only feeds
 * `Number()` to `Intl.NumberFormat` for presentation, never for arithmetic.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { classifyCaughtProviderError } from '@/features/estate/error-taxonomy';
import {
  estateBlocked,
  estateError,
  estateOk,
  type EstateSectionResult
} from '@/features/estate/types';
import {
  BILLING_CLIENT_PURPOSE,
  BILLING_DRAFT_PUSH_PURPOSE,
  INVOICENINJA_PROVIDER
} from '@/server/finance-billing';
import type {
  InvoiceNinjaAdapter,
  InvoiceNinjaContactFact,
  InvoiceNinjaLineItemFact
} from '@loxep/integration-invoiceninja';

function iso(date: Date): string {
  return date.toISOString();
}

const PAGE_SCHEMA = z.number().int().min(1);

/** Resolves the connection and throws unless it is really an Invoice Ninja one — every handler below starts here. */
async function requireInvoiceNinjaConnection(connectionId: string) {
  const { getAdminServices } = await import('@/server/admin');
  const { connections } = getAdminServices();
  const connection = await connections.getConnection(connectionId);
  if (connection.provider !== INVOICENINJA_PROVIDER) {
    throw new Error(`connection "${connectionId}" is not an Invoice Ninja connection`);
  }
  return connection;
}

type InvoiceNinjaAdapterResolution =
  | { status: 'ready'; adapter: InvoiceNinjaAdapter }
  | { status: 'blocked'; reason: string };

/**
 * Builds a fresh adapter exactly the way `pushDraftInvoice`
 * (`finance-billing-functions.ts`) already does — reading the connection's
 * non-secret `config.invoiceninja.baseUrl` and its `invoiceninja_credentials`
 * bundle directly, with NO `@/server/admin` accessor of its own (this
 * provider has none, and adding one is outside this bead's edit fence). A
 * missing base URL or credential bundle is a Loxep-side configuration gap,
 * not a provider failure — it renders BLOCKED (Rule P13), never thrown and
 * never an ERROR.
 */
async function resolveInvoiceNinjaAdapter(
  connection: Awaited<ReturnType<typeof requireInvoiceNinjaConnection>>
): Promise<InvoiceNinjaAdapterResolution> {
  const [{ getAdminServices }, ninja] = await Promise.all([
    import('@/server/admin'),
    import('@loxep/integration-invoiceninja')
  ]);
  const { connections } = getAdminServices();

  const config = connection.config['invoiceninja'] as { baseUrl?: string } | undefined;
  const baseUrl = config?.baseUrl;
  if (baseUrl === undefined || baseUrl === '') {
    return {
      status: 'blocked',
      reason: 'This connection has no Invoice Ninja base URL configured yet.'
    };
  }

  let apiToken: string;
  try {
    const credential = await connections.getConnectionCredentialPayload(
      connection.id,
      'invoiceninja_credentials'
    );
    apiToken = credential.payload.apiToken;
  } catch {
    return {
      status: 'blocked',
      reason: 'This connection has no Invoice Ninja API token stored yet.'
    };
  }

  return { status: 'ready', adapter: ninja.createInvoiceNinjaAdapter({ baseUrl, apiToken }) };
}

// ---------------------------------------------------------------------------
// Clients — the overview, EXACTLY one call per invocation (one page)
// ---------------------------------------------------------------------------

/**
 * Whether this Invoice Ninja client is already a projection of a Loxep
 * `counterparties` row — via the SAME `resource_links`
 * (`purpose='billing_client'`) row `pushDraftInvoice`'s `ensureNinjaClient`
 * already writes. There is no counterparty detail route in this app today,
 * so `'linked'` carries the counterparty's own facts for a plain-text render
 * rather than a link target.
 */
export type InvoiceNinjaEstateClientCrossReference =
  | {
      kind: 'linked';
      counterpartyId: string;
      counterpartyDisplayName: string;
      counterpartyReferenceCode: string;
    }
  | { kind: 'unlinked' };

/**
 * Pure cross-reference decision, exported and unit-tested with fakes (no
 * database) — the same shape `dockhandEnvironmentCrossReference` established.
 */
export function invoiceNinjaClientCrossReference(
  resource: { id: string } | undefined,
  counterpartyIdByExternalResourceId: ReadonlyMap<string, string>,
  counterpartyById: ReadonlyMap<string, { displayName: string; referenceCode: string }>
): InvoiceNinjaEstateClientCrossReference {
  if (resource === undefined) return { kind: 'unlinked' };
  const counterpartyId = counterpartyIdByExternalResourceId.get(resource.id);
  if (counterpartyId === undefined) return { kind: 'unlinked' };
  const counterparty = counterpartyById.get(counterpartyId);
  if (counterparty === undefined) return { kind: 'unlinked' };
  return {
    kind: 'linked',
    counterpartyId,
    counterpartyDisplayName: counterparty.displayName,
    counterpartyReferenceCode: counterparty.referenceCode
  };
}

export interface InvoiceNinjaEstateClientDto {
  externalClientId: string;
  name: string;
  displayName: string;
  number: string | null;
  idNumber: string | null;
  vatNumber: string | null;
  /** DECIMAL string — see this module's own "Money" doc. */
  balance: string;
  /** DECIMAL string. */
  paidToDate: string;
  isDeleted: boolean;
  updatedAt: string | null;
  crossReference: InvoiceNinjaEstateClientCrossReference;
}

export interface InvoiceNinjaEstateClientPageDto {
  clients: InvoiceNinjaEstateClientDto[];
  /** The page number this DTO IS — echoed back so the client can key its per-page cache. */
  page: number;
  hasNextPage: boolean;
}

const fetchInvoiceNinjaEstateClientsInput = z.strictObject({
  connectionId: z.uuid(),
  page: PAGE_SCHEMA
});

/**
 * Fetches EXACTLY ONE page of clients — one `fetchClientsPage` call, always,
 * regardless of which page number is asked for (see this module's own
 * "Sections, and their call cost" doc for why a multi-page server-side loop
 * is a rejected design here).
 */
export const fetchInvoiceNinjaEstateClients = createServerFn({ method: 'GET' })
  .inputValidator(fetchInvoiceNinjaEstateClientsInput)
  .handler(async ({ data }): Promise<EstateSectionResult<InvoiceNinjaEstateClientPageDto>> => {
    const { requireSession } = await import('@/server/admin');
    await requireSession();
    const connection = await requireInvoiceNinjaConnection(data.connectionId);
    const readAt = iso(new Date());

    const resolved = await resolveInvoiceNinjaAdapter(connection);
    if (resolved.status === 'blocked') {
      return estateBlocked(resolved.reason, readAt);
    }

    const ninja = await import('@loxep/integration-invoiceninja');
    let clients: InvoiceNinjaEstateClientDto[];
    let hasNextPage: boolean;
    try {
      const result = await ninja.fetchClientsPage(resolved.adapter, {
        page: data.page,
        perPage: ninja.INVOICENINJA_DEFAULT_PER_PAGE
      });
      clients = result.clients.map((client) => ({
        externalClientId: client.externalClientId,
        name: client.name,
        displayName: client.displayName,
        number: client.number,
        idNumber: client.idNumber,
        vatNumber: client.vatNumber,
        balance: client.balance,
        paidToDate: client.paidToDate,
        isDeleted: client.isDeleted,
        updatedAt: client.updatedAt,
        crossReference: { kind: 'unlinked' } as InvoiceNinjaEstateClientCrossReference
      }));
      hasNextPage = result.page.hasNextPage;
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not read Invoice Ninja clients.'),
        readAt
      );
    }

    const { getAdminServices } = await import('@/server/admin');
    const { handle } = getAdminServices();
    const clientIds = clients.map((client) => client.externalClientId);
    const resources =
      clientIds.length === 0
        ? []
        : await handle.db.query.externalResources.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.provider, INVOICENINJA_PROVIDER),
                eq(table.externalType, 'client'),
                eq(table.connectionId, data.connectionId),
                inArray(table.externalId, clientIds)
              ),
            columns: { id: true, externalId: true }
          });
    const resourceByClientId = new Map(
      resources
        .filter((row): row is typeof row & { externalId: string } => row.externalId !== null)
        .map((row) => [row.externalId, row])
    );
    const resourceIds = resources.map((row) => row.id);
    const links =
      resourceIds.length === 0
        ? []
        : await handle.db.query.resourceLinks.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                inArray(table.externalResourceId, resourceIds),
                eq(table.resourceType, 'counterparty'),
                eq(table.purpose, BILLING_CLIENT_PURPOSE)
              ),
            columns: { externalResourceId: true, resourceId: true }
          });
    const counterpartyIdByExternalResourceId = new Map(
      links.map((link) => [link.externalResourceId, link.resourceId])
    );
    const counterpartyIds = [...new Set(links.map((link) => link.resourceId))];
    const counterparties =
      counterpartyIds.length === 0
        ? []
        : await handle.db.query.counterparties.findMany({
            where: (table, { inArray }) => inArray(table.id, counterpartyIds),
            columns: { id: true, displayName: true, referenceCode: true }
          });
    const counterpartyById = new Map(
      counterparties.map((row) => [
        row.id,
        { displayName: row.displayName, referenceCode: row.referenceCode }
      ])
    );

    return estateOk<InvoiceNinjaEstateClientPageDto>(
      {
        clients: clients.map((client) => ({
          ...client,
          crossReference: invoiceNinjaClientCrossReference(
            resourceByClientId.get(client.externalClientId),
            counterpartyIdByExternalResourceId,
            counterpartyById
          )
        })),
        page: data.page,
        hasNextPage
      },
      readAt
    );
  });

// ---------------------------------------------------------------------------
// One client — the drill-in, ON EXPAND ONLY (Rule P6). Adds `contacts[]`,
// which the overview row deliberately omits.
// ---------------------------------------------------------------------------

export interface InvoiceNinjaEstateClientDetailDto {
  externalClientId: string;
  name: string;
  displayName: string;
  number: string | null;
  idNumber: string | null;
  vatNumber: string | null;
  balance: string;
  paidToDate: string;
  isDeleted: boolean;
  updatedAt: string | null;
  contacts: InvoiceNinjaContactFact[];
}

const fetchInvoiceNinjaEstateClientDetailInput = z.strictObject({
  connectionId: z.uuid(),
  externalClientId: z.string().trim().min(1)
});

export const fetchInvoiceNinjaEstateClientDetail = createServerFn({ method: 'GET' })
  .inputValidator(fetchInvoiceNinjaEstateClientDetailInput)
  .handler(async ({ data }): Promise<EstateSectionResult<InvoiceNinjaEstateClientDetailDto>> => {
    const { requireSession } = await import('@/server/admin');
    await requireSession();
    const connection = await requireInvoiceNinjaConnection(data.connectionId);
    const readAt = iso(new Date());

    const resolved = await resolveInvoiceNinjaAdapter(connection);
    if (resolved.status === 'blocked') {
      return estateBlocked(resolved.reason, readAt);
    }

    try {
      const ninja = await import('@loxep/integration-invoiceninja');
      const client = await ninja.fetchClient(resolved.adapter, data.externalClientId);
      return estateOk<InvoiceNinjaEstateClientDetailDto>(
        {
          externalClientId: client.externalClientId,
          name: client.name,
          displayName: client.displayName,
          number: client.number,
          idNumber: client.idNumber,
          vatNumber: client.vatNumber,
          balance: client.balance,
          paidToDate: client.paidToDate,
          isDeleted: client.isDeleted,
          updatedAt: client.updatedAt,
          contacts: client.contacts
        },
        readAt
      );
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not read this Invoice Ninja client.'),
        readAt
      );
    }
  });

// ---------------------------------------------------------------------------
// Invoices — the overview, one call per "Load more" batch
// ---------------------------------------------------------------------------

/**
 * Whether this Invoice Ninja invoice is already the target of a Loxep draft
 * push — via the SAME `resource_links` (`purpose='billing_invoice_draft'`)
 * row `pushDraftInvoice` already writes, `resource_type` `'project'` or
 * `'counterparty'` (never `'invoice'` — see this module's own doc). A
 * `'linked'` row names the counterparty (and, when the push was project-
 * scoped, the project's reference code) and links to `/finance/overview` —
 * the existing push dialog's home — per this bead's own instruction; it
 * never links to a counterparty page, because none exists.
 */
export type InvoiceNinjaEstateInvoiceCrossReference =
  | { kind: 'linked'; counterpartyDisplayName: string | null; projectReferenceCode: string | null }
  | { kind: 'unlinked' };

/** Pure cross-reference decision, exported and unit-tested with fakes. */
export function invoiceNinjaInvoiceCrossReference(
  resource: { id: string } | undefined,
  linkByExternalResourceId: ReadonlyMap<string, { resourceType: string; resourceId: string }>,
  counterpartyById: ReadonlyMap<string, { displayName: string }>,
  projectById: ReadonlyMap<string, { referenceCode: string; counterpartyId: string | null }>
): InvoiceNinjaEstateInvoiceCrossReference {
  if (resource === undefined) return { kind: 'unlinked' };
  const link = linkByExternalResourceId.get(resource.id);
  if (link === undefined) return { kind: 'unlinked' };

  if (link.resourceType === 'counterparty') {
    const counterparty = counterpartyById.get(link.resourceId);
    return {
      kind: 'linked',
      counterpartyDisplayName: counterparty?.displayName ?? null,
      projectReferenceCode: null
    };
  }

  if (link.resourceType === 'project') {
    const project = projectById.get(link.resourceId);
    const counterparty =
      project?.counterpartyId !== undefined && project.counterpartyId !== null
        ? counterpartyById.get(project.counterpartyId)
        : undefined;
    return {
      kind: 'linked',
      counterpartyDisplayName: counterparty?.displayName ?? null,
      projectReferenceCode: project?.referenceCode ?? null
    };
  }

  return { kind: 'unlinked' };
}

export interface InvoiceNinjaEstateInvoiceDto {
  externalInvoiceId: string;
  externalClientId: string | null;
  /** '' until Ninja assigns one → mapped to null, matching the adapter's own convention. */
  number: string | null;
  /** The adapter's own mapped status vocabulary (`INVOICENINJA_INVOICE_STATUS_MAP`) — a shipped integration-boundary translation, not a Loxep-coined verdict. */
  status: string;
  /** Invoice Ninja's own status_id, verbatim, for when `status` fell back to `draft` because the wire value was unrecognized. */
  statusIdRaw: string;
  statusRecognized: boolean;
  /** DECIMAL string. */
  amount: string;
  /** DECIMAL string. */
  balance: string;
  /** DECIMAL string. */
  paidToDate: string;
  issueOn: string | null;
  dueOn: string | null;
  poNumber: string | null;
  isDeleted: boolean;
  updatedAt: string | null;
  portalUrl: string | null;
  crossReference: InvoiceNinjaEstateInvoiceCrossReference;
}

export interface InvoiceNinjaEstateInvoicePageDto {
  invoices: InvoiceNinjaEstateInvoiceDto[];
  /** The page number this DTO IS — echoed back so the client can key its per-page cache. */
  page: number;
  hasNextPage: boolean;
}

const fetchInvoiceNinjaEstateInvoicesInput = z.strictObject({
  connectionId: z.uuid(),
  page: PAGE_SCHEMA
});

/**
 * Fetches EXACTLY ONE page of invoices — one `fetchInvoicesPage` call,
 * always, regardless of which page number is asked for (see this module's
 * own "Sections, and their call cost" doc).
 */
export const fetchInvoiceNinjaEstateInvoices = createServerFn({ method: 'GET' })
  .inputValidator(fetchInvoiceNinjaEstateInvoicesInput)
  .handler(async ({ data }): Promise<EstateSectionResult<InvoiceNinjaEstateInvoicePageDto>> => {
    const { requireSession } = await import('@/server/admin');
    await requireSession();
    const connection = await requireInvoiceNinjaConnection(data.connectionId);
    const readAt = iso(new Date());

    const resolved = await resolveInvoiceNinjaAdapter(connection);
    if (resolved.status === 'blocked') {
      return estateBlocked(resolved.reason, readAt);
    }

    const ninja = await import('@loxep/integration-invoiceninja');
    let invoices: InvoiceNinjaEstateInvoiceDto[];
    let hasNextPage: boolean;
    try {
      const result = await ninja.fetchInvoicesPage(resolved.adapter, {
        page: data.page,
        perPage: ninja.INVOICENINJA_DEFAULT_PER_PAGE
      });
      invoices = result.invoices.map((invoice) => ({
        externalInvoiceId: invoice.externalInvoiceId,
        externalClientId: invoice.externalClientId,
        number: invoice.number,
        status: invoice.status,
        statusIdRaw: invoice.statusIdRaw,
        statusRecognized: invoice.statusRecognized,
        amount: invoice.amount,
        balance: invoice.balance,
        paidToDate: invoice.paidToDate,
        issueOn: invoice.issueOn,
        dueOn: invoice.dueOn,
        poNumber: invoice.poNumber,
        isDeleted: invoice.isDeleted,
        updatedAt: invoice.updatedAt,
        portalUrl: invoice.portalUrl,
        crossReference: { kind: 'unlinked' } as InvoiceNinjaEstateInvoiceCrossReference
      }));
      hasNextPage = result.page.hasNextPage;
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not read Invoice Ninja invoices.'),
        readAt
      );
    }

    const { getAdminServices } = await import('@/server/admin');
    const { handle } = getAdminServices();
    const invoiceIds = invoices.map((invoice) => invoice.externalInvoiceId);
    const resources =
      invoiceIds.length === 0
        ? []
        : await handle.db.query.externalResources.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                eq(table.provider, INVOICENINJA_PROVIDER),
                eq(table.externalType, 'invoice_draft'),
                eq(table.connectionId, data.connectionId),
                inArray(table.externalId, invoiceIds)
              ),
            columns: { id: true, externalId: true }
          });
    const resourceByInvoiceId = new Map(
      resources
        .filter((row): row is typeof row & { externalId: string } => row.externalId !== null)
        .map((row) => [row.externalId, row])
    );
    const resourceIds = resources.map((row) => row.id);
    const links =
      resourceIds.length === 0
        ? []
        : await handle.db.query.resourceLinks.findMany({
            where: (table, { and, eq, inArray }) =>
              and(
                inArray(table.externalResourceId, resourceIds),
                eq(table.purpose, BILLING_DRAFT_PUSH_PURPOSE)
              ),
            columns: { externalResourceId: true, resourceType: true, resourceId: true }
          });
    const linkByExternalResourceId = new Map(
      links.map((link) => [
        link.externalResourceId,
        { resourceType: link.resourceType, resourceId: link.resourceId }
      ])
    );

    const counterpartyIdsFromLinks = links
      .filter((link) => link.resourceType === 'counterparty')
      .map((link) => link.resourceId);
    const projectIds = links
      .filter((link) => link.resourceType === 'project')
      .map((link) => link.resourceId);

    const projects =
      projectIds.length === 0
        ? []
        : await handle.db.query.projects.findMany({
            where: (table, { inArray }) => inArray(table.id, [...new Set(projectIds)]),
            columns: { id: true, referenceCode: true, counterpartyId: true }
          });
    const projectById = new Map(
      projects.map((row) => [
        row.id,
        { referenceCode: row.referenceCode, counterpartyId: row.counterpartyId }
      ])
    );

    const allCounterpartyIds = [
      ...new Set([
        ...counterpartyIdsFromLinks,
        ...projects
          .map((project) => project.counterpartyId)
          .filter((id): id is string => id !== null)
      ])
    ];
    const counterparties =
      allCounterpartyIds.length === 0
        ? []
        : await handle.db.query.counterparties.findMany({
            where: (table, { inArray }) => inArray(table.id, allCounterpartyIds),
            columns: { id: true, displayName: true }
          });
    const counterpartyById = new Map(
      counterparties.map((row) => [row.id, { displayName: row.displayName }])
    );

    return estateOk<InvoiceNinjaEstateInvoicePageDto>(
      {
        invoices: invoices.map((invoice) => ({
          ...invoice,
          crossReference: invoiceNinjaInvoiceCrossReference(
            resourceByInvoiceId.get(invoice.externalInvoiceId),
            linkByExternalResourceId,
            counterpartyById,
            projectById
          )
        })),
        page: data.page,
        hasNextPage
      },
      readAt
    );
  });

// ---------------------------------------------------------------------------
// One invoice — the drill-in, ON EXPAND ONLY (Rule P6). Adds `lineItems[]`,
// which the overview row deliberately omits.
// ---------------------------------------------------------------------------

export interface InvoiceNinjaEstateInvoiceDetailDto {
  externalInvoiceId: string;
  externalClientId: string | null;
  number: string | null;
  status: string;
  statusIdRaw: string;
  statusRecognized: boolean;
  amount: string;
  balance: string;
  paidToDate: string;
  issueOn: string | null;
  dueOn: string | null;
  poNumber: string | null;
  isDeleted: boolean;
  updatedAt: string | null;
  portalUrl: string | null;
  lineItems: InvoiceNinjaLineItemFact[];
}

const fetchInvoiceNinjaEstateInvoiceDetailInput = z.strictObject({
  connectionId: z.uuid(),
  externalInvoiceId: z.string().trim().min(1)
});

export const fetchInvoiceNinjaEstateInvoiceDetail = createServerFn({ method: 'GET' })
  .inputValidator(fetchInvoiceNinjaEstateInvoiceDetailInput)
  .handler(async ({ data }): Promise<EstateSectionResult<InvoiceNinjaEstateInvoiceDetailDto>> => {
    const { requireSession } = await import('@/server/admin');
    await requireSession();
    const connection = await requireInvoiceNinjaConnection(data.connectionId);
    const readAt = iso(new Date());

    const resolved = await resolveInvoiceNinjaAdapter(connection);
    if (resolved.status === 'blocked') {
      return estateBlocked(resolved.reason, readAt);
    }

    try {
      const ninja = await import('@loxep/integration-invoiceninja');
      const invoice = await ninja.fetchInvoice(resolved.adapter, data.externalInvoiceId);
      return estateOk<InvoiceNinjaEstateInvoiceDetailDto>(
        {
          externalInvoiceId: invoice.externalInvoiceId,
          externalClientId: invoice.externalClientId,
          number: invoice.number,
          status: invoice.status,
          statusIdRaw: invoice.statusIdRaw,
          statusRecognized: invoice.statusRecognized,
          amount: invoice.amount,
          balance: invoice.balance,
          paidToDate: invoice.paidToDate,
          issueOn: invoice.issueOn,
          dueOn: invoice.dueOn,
          poNumber: invoice.poNumber,
          isDeleted: invoice.isDeleted,
          updatedAt: invoice.updatedAt,
          portalUrl: invoice.portalUrl,
          lineItems: invoice.lineItems
        },
        readAt
      );
    } catch (error) {
      return estateError(
        classifyCaughtProviderError(error, 'Could not read this Invoice Ninja invoice.'),
        readAt
      );
    }
  });
