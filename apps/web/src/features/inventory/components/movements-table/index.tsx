import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { parseSortingState } from '@/lib/parsers';
import { inventoryMovementsQuery } from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { InventoryMovementListItemDto } from '@/server/inventory-functions';
import { columns, columnIds } from './columns';

const DEFAULT_PAGE_SIZE = 20;

/** The append-only movement ledger across every item — `/inventory/movements`. */
export default function MovementsTable() {
  const { data, isPending, isError, error, refetch } = useQuery(inventoryMovementsQuery({}));

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={0} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load movements' onRetry={() => refetch()} />
    );
  }

  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.refunds />
          </EmptyMedia>
          <EmptyTitle>No movements yet</EmptyTitle>
          <EmptyDescription>
            Every quantity or location change on a stock row is logged here, append-only — a
            receipt, a transfer, a sale depletion, a correction reversal.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <MovementsDataTable movements={data} />;
}

function MovementsDataTable({ movements }: { movements: InventoryMovementListItemDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const sorting = parseSortingState<InventoryMovementListItemDto>(sortStr, columnIds);
  const sorted = sortRows(movements, sorting, {
    quantity: (row) => Number(row.quantity),
    occurredAt: (row) => row.occurredAt
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
      sorting: [{ id: 'occurredAt', desc: true }]
    }
  });

  return <DataTable table={table} />;
}
