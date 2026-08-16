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
import { invoiceNinjaEstateClientsPageQuery } from '@/features/finance/estate/api/queries';
import { combinePagedEstateResults } from '@/features/finance/estate/lib/combine-paged-estate-section';
import type {
  InvoiceNinjaEstateClientDto,
  InvoiceNinjaEstateClientPageDto
} from '@/server/invoiceninja-estate-functions';
import { invoiceNinjaClientColumns } from './client-columns';

const CLIENT_COLUMNS: ClientColumnSpec<InvoiceNinjaEstateClientDto>[] = [
  { id: 'displayName', accessor: (row) => row.displayName || row.name, filterVariant: 'text' }
];

function ClientsTable({
  clients,
  selectedClientId,
  onViewDetail
}: {
  clients: InvoiceNinjaEstateClientDto[];
  selectedClientId: string | null;
  onViewDetail: (client: InvoiceNinjaEstateClientDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(clients, CLIENT_COLUMNS, search, page, perPage);
  const columns = React.useMemo(
    () => invoiceNinjaClientColumns(onViewDetail, selectedClientId),
    [onViewDetail, selectedClientId]
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
 * The Invoice Ninja estate's CLIENTS section (Estate Browsers Design §3.9) —
 * the first HALF of the two-call overview (Rule P7): `fetchClientsPage`,
 * page 1 on first render. "Load more" (Rule P8) adds exactly one PAGE
 * NUMBER to the `useQueries` array below — a click costs exactly one
 * provider call, for exactly the next page; pages already loaded are served
 * from the query cache, never re-fetched (see `invoiceninja-estate-
 * functions.ts`'s own module doc for why a server-side multi-page loop was
 * rejected). `combinePagedEstateResults` folds the per-page results back
 * into the single `EstateSectionResult` `EstateSection` already renders.
 * Cross-referenced against `resource_links`/`counterparties`. Zero write
 * affordances — `createClient`/`updateClient` are never imported anywhere
 * near this component.
 */
export default function InvoiceNinjaClientsSection({
  connectionId,
  selectedClientId,
  onViewDetail
}: {
  connectionId: string;
  selectedClientId: string | null;
  onViewDetail: (client: InvoiceNinjaEstateClientDto) => void;
}) {
  const [pageCount, setPageCount] = React.useState(1);
  const queries = useQueries({
    queries: Array.from({ length: pageCount }, (_, index) =>
      invoiceNinjaEstateClientsPageQuery(connectionId, index + 1)
    )
  });

  const firstQuery = queries[0];
  const lastQuery = queries[queries.length - 1];
  const combined = combinePagedEstateResults<
    InvoiceNinjaEstateClientPageDto,
    InvoiceNinjaEstateClientDto
  >(
    queries.map((query) => query.data),
    (page) => page.clients
  );

  return (
    <EstateSection
      title='Clients'
      description="Live from Invoice Ninja's fetchClientsPage — one page per call."
      isPending={firstQuery?.isPending ?? true}
      isError={queries.some((query) => query.isError)}
      error={queries.find((query) => query.isError)?.error}
      onRetry={() => void lastQuery?.refetch()}
      result={combined}
      isEmpty={(value) => value.items.length === 0}
      emptyMessage='This Invoice Ninja account has no clients.'
      children={(value) => (
        <div className='flex flex-col gap-3'>
          <ClientsTable
            clients={value.items}
            selectedClientId={selectedClientId}
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
              {lastQuery?.isFetching ? 'Loading…' : 'Load more clients — one more call'}
            </Button>
          )}
        </div>
      )}
    />
  );
}
