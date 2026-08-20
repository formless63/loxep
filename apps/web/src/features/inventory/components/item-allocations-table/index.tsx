import { useTable } from '@tanstack/react-table';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { dataTableFeatures } from '@/lib/table-features';
import { Icons } from '@/components/icons';
import type { ItemAllocationDto } from '@/server/inventory-functions';
import { getColumns } from './columns';

const COLUMNS = getColumns();

/**
 * The rows behind `availableToSell` (loxep-rh0): every `inventory_allocations`
 * row against this item, answering "which order line, or which
 * `manual_hold` nobody released". A fixed, already-fetched row set scoped to
 * one item (part of `fetchInventoryItem`'s combined DTO, not its own query),
 * so — like `book-trial-balance.tsx` — this drives `DataTable` off a local
 * `useTable` instead of URL-synced `useDataTable`.
 */
export default function ItemAllocationsTable({
  allocations
}: {
  allocations: ItemAllocationDto[];
}) {
  const table = useTable({
    data: allocations,
    columns: COLUMNS,
    features: dataTableFeatures,
    getRowId: (row) => row.id,
    manualPagination: true
  });

  if (allocations.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.circleCheck />
          </EmptyMedia>
          <EmptyTitle>No allocations</EmptyTitle>
          <EmptyDescription>
            Nothing has ever reserved stock against this item — on-hand and available-to-sell are
            the same number.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <DataTable table={table} />;
}
