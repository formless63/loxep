import { queryOptions } from '@tanstack/react-query';
import {
  fetchInvoiceNinjaEstateClientDetail,
  fetchInvoiceNinjaEstateClients,
  fetchInvoiceNinjaEstateInvoiceDetail,
  fetchInvoiceNinjaEstateInvoices
} from '@/server/invoiceninja-estate-functions';

/**
 * The Invoice Ninja estate browser's (loxep-47o.8) query options — the
 * `/finance` sibling of `features/infrastructure/api/queries.ts`'s own
 * estate queries, same live/never-cached discipline (Rule P5): no long
 * `staleTime`, every render re-reads the provider fresh.
 *
 * `page` is IN the Clients/Invoices query keys — ONE query per page number,
 * each independently cached. `{clients,invoices}-section.tsx` hold one
 * `useQueries` call over the array of page numbers an operator has
 * requested so far (growing by exactly one per "Load more" click) and merge
 * the results with `combine-paged-estate-section.ts`'s pure
 * `combinePagedEstateResults`. This is the shape Rule P8 requires for a
 * TRUE page-number provider API: a click costs exactly one call for exactly
 * the next page, never a re-fetch of pages already in the cache — see
 * `invoiceninja-estate-functions.ts`'s own module doc for the numeric
 * argument against the rejected alternative (a server-side page-1..N loop).
 */
export const invoiceNinjaEstateClientsPageQuery = (connectionId: string, page: number) =>
  queryOptions({
    queryKey: ['finance', 'invoiceninja-estate', connectionId, 'clients', page],
    queryFn: () => fetchInvoiceNinjaEstateClients({ data: { connectionId, page } })
  });

/** One client's live detail — the per-row drill-in (Rule P6), fetched only once an operator expands that row. */
export const invoiceNinjaEstateClientDetailQuery = (
  connectionId: string,
  externalClientId: string
) =>
  queryOptions({
    queryKey: ['finance', 'invoiceninja-estate', connectionId, 'client', externalClientId],
    queryFn: () => fetchInvoiceNinjaEstateClientDetail({ data: { connectionId, externalClientId } })
  });

export const invoiceNinjaEstateInvoicesPageQuery = (connectionId: string, page: number) =>
  queryOptions({
    queryKey: ['finance', 'invoiceninja-estate', connectionId, 'invoices', page],
    queryFn: () => fetchInvoiceNinjaEstateInvoices({ data: { connectionId, page } })
  });

/** One invoice's live detail — the per-row drill-in (Rule P6), fetched only once an operator expands that row. */
export const invoiceNinjaEstateInvoiceDetailQuery = (
  connectionId: string,
  externalInvoiceId: string
) =>
  queryOptions({
    queryKey: ['finance', 'invoiceninja-estate', connectionId, 'invoice', externalInvoiceId],
    queryFn: () =>
      fetchInvoiceNinjaEstateInvoiceDetail({ data: { connectionId, externalInvoiceId } })
  });
