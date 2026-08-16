import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { invoiceNinjaEstateInvoicesPageQuery } from '@/features/finance/estate/api/queries';
import { combinePagedEstateResults } from '@/features/finance/estate/lib/combine-paged-estate-section';
import type {
  InvoiceNinjaEstateInvoiceDto,
  InvoiceNinjaEstateInvoicePageDto
} from '@/server/invoiceninja-estate-functions';
import { invoiceNinjaInvoiceColumns } from './invoice-columns';

const CLIENT_COLUMNS: ClientColumnSpec<InvoiceNinjaEstateInvoiceDto>[] = [
  { id: 'status', accessor: (row) => row.status, filterVariant: 'multiSelect' }
];

function InvoicesTable({
  invoices,
  selectedInvoiceId,
  onViewDetail
}: {
  invoices: InvoiceNinjaEstateInvoiceDto[];
  selectedInvoiceId: string | null;
  onViewDetail: (invoice: InvoiceNinjaEstateInvoiceDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    invoices,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const columns = React.useMemo(
    () => invoiceNinjaInvoiceColumns(onViewDetail, selectedInvoiceId),
    [onViewDetail, selectedInvoiceId]
  );
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Invoice Ninja estate's INVOICES section (Estate Browsers Design §3.9)
 * — the second HALF of the two-call overview (Rule P7): `fetchInvoicesPage`,
 * page 1 on first render. "Load more" (Rule P8) adds exactly one PAGE
 * NUMBER to the `useQueries` array below — a click costs exactly one
 * provider call, for exactly the next page; pages already loaded are served
 * from the query cache, never re-fetched — the same shape
 * `clients-section.tsx` uses, see that file and `invoiceninja-estate-
 * functions.ts`'s own module doc for the full reasoning. Cross-referenced
 * against `resource_links` (`purpose='billing_invoice_draft'`)/
 * `counterparties`/`projects`. A linked row's "Loxep record" cell links to
 * `/finance/overview` — where the push dialog already lives — never a
 * second push entry point. Zero write affordances — `createInvoice`,
 * `updateInvoice`, and `markInvoiceSent` (a GET that mutates) are never
 * imported anywhere near this component.
 */
export default function InvoiceNinjaInvoicesSection({
  connectionId,
  selectedInvoiceId,
  onViewDetail
}: {
  connectionId: string;
  selectedInvoiceId: string | null;
  onViewDetail: (invoice: InvoiceNinjaEstateInvoiceDto) => void;
}) {
  const [pageCount, setPageCount] = React.useState(1);
  const queries = useQueries({
    queries: Array.from({ length: pageCount }, (_, index) =>
      invoiceNinjaEstateInvoicesPageQuery(connectionId, index + 1)
    )
  });

  const firstQuery = queries[0];
  const lastQuery = queries[queries.length - 1];
  const combined = combinePagedEstateResults<
    InvoiceNinjaEstateInvoicePageDto,
    InvoiceNinjaEstateInvoiceDto
  >(
    queries.map((query) => query.data),
    (page) => page.invoices
  );

  return (
    <EstateSection
      title='Invoices'
      description="Live from Invoice Ninja's fetchInvoicesPage — one page per call."
      isPending={firstQuery?.isPending ?? true}
      isError={queries.some((query) => query.isError)}
      error={queries.find((query) => query.isError)?.error}
      onRetry={() => void lastQuery?.refetch()}
      result={combined}
      isEmpty={(value) => value.items.length === 0}
      emptyMessage='This Invoice Ninja account has no invoices.'
      children={(value) => (
        <div className='flex flex-col gap-3'>
          <InvoicesTable
            invoices={value.items}
            selectedInvoiceId={selectedInvoiceId}
            onViewDetail={onViewDetail}
          />
          {value.hasNextPage && (
            <Button
              size='sm'
              variant='outline'
              className='self-start'
              disabled={lastQuery?.isFetching}
              onClick={() => setPageCount((current) => current + 1)}
            >
              {lastQuery?.isFetching ? 'Loading…' : 'Load more invoices — one more call'}
            </Button>
          )}
        </div>
      )}
    />
  );
}
