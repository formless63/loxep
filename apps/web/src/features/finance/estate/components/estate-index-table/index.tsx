import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { connectionsQuery, providerWritePolicyQuery } from '@/features/settings/api/queries';
import { lastActivityTimestamp } from '@/features/settings/components/connections-table/columns';
import { FINANCE_ESTATE_CATEGORY_PROVIDERS } from '@/features/estate/provider-registry';
import type { ConnectionDto } from '@/server/admin-functions';
import { getFinanceEstateIndexColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<ConnectionDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' },
  { id: 'provider', accessor: (row) => row.provider, filterVariant: 'multiSelect' },
  { id: 'health', accessor: (row) => lastActivityTimestamp(row) ?? '' }
];

/**
 * `/finance/estate`'s index (Rule N2's "`/finance` gains the equivalent when
 * Invoice Ninja's wave lands") — the `/finance` sibling of
 * `features/infrastructure/components/estate-index-table/index.tsx`, same
 * shape exactly: every finance-category connection, one row each, whether or
 * not its provider has a shipped estate page yet. Deliberately NOT scoped to
 * `hasEstatePage`, for the same reason the infrastructure index isn't — see
 * that component's own doc.
 */
export default function FinanceEstateIndexTable() {
  const { data, isPending, isError, error, refetch } = useQuery(connectionsQuery);
  const { data: writePolicyMap } = useQuery(providerWritePolicyQuery);
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;

  if (isPending) {
    return <DataTableSkeleton columnCount={5} filterCount={2} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Failed to load finance connections'
        onRetry={() => refetch()}
      />
    );
  }

  const connections = data.filter(
    (connection) =>
      connection.status !== 'archived' && FINANCE_ESTATE_CATEGORY_PROVIDERS.has(connection.provider)
  );
  const columns = getFinanceEstateIndexColumns({ writePolicies: writePolicyMap ?? {} });
  const { rows, pageCount } = applyClientTableState(
    connections,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );

  return <FinanceEstateIndexDataTable rows={rows} pageCount={pageCount} columns={columns} />;
}

function FinanceEstateIndexDataTable({
  rows,
  pageCount,
  columns
}: {
  rows: ConnectionDto[];
  pageCount: number;
  columns: ReturnType<typeof getFinanceEstateIndexColumns>;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (connection) => connection.id,
    shallow: true,
    debounceMs: 500
  });
  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
