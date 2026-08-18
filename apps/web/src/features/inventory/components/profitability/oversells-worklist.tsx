import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { Icons } from '@/components/icons';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatQuantity } from '@/lib/format';
import type { OversellDto } from '@/server/inventory-functions';

function buildColumns(): ColumnDef<DataTableFeatures, OversellDto>[] {
  return [
    {
      id: 'itemCode',
      accessorKey: 'itemCode',
      header: 'Item',
      cell: ({ row }) => (
        <Link
          to='/inventory/stock/$id'
          params={{ id: row.original.inventoryItemId }}
          className='font-medium hover:underline'
        >
          {row.original.itemCode}
        </Link>
      )
    },
    {
      id: 'quantityOnHand',
      accessorKey: 'quantityOnHand',
      header: () => <div className='text-right'>Quantity on hand</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium text-destructive tabular-nums'>
          {formatQuantity(Number(row.original.quantityOnHand))}
        </div>
      )
    }
  ];
}

/**
 * Cached on-hand gone negative — the oversell exception, surfaced loudly
 * (audit A11's integrity worklist). Empty is the healthy state here, so the
 * empty composition below is reassuring, not a call to action.
 */
export default function OversellsWorklist({ rows }: { rows: OversellDto[] }) {
  const table = useTable({
    data: rows,
    columns: buildColumns(),
    features: dataTableFeatures,
    getRowId: (row) => row.inventoryItemId,
    manualPagination: true
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Oversells</CardTitle>
        <CardDescription>
          Items whose cached on-hand quantity has gone negative — a ledger inconsistency, not a
          normal state.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon' className='bg-success/15 text-success'>
                <Icons.check />
              </EmptyMedia>
              <EmptyTitle>No oversells</EmptyTitle>
              <EmptyDescription>
                Every item&rsquo;s on-hand quantity is non-negative.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DataTable table={table} />
        )}
      </CardContent>
    </Card>
  );
}
