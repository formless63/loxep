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
import { formatMoney, formatQuantity } from '@/lib/format';
import type { UnmatchedDepletionDto } from '@/server/inventory-functions';

function buildColumns(): ColumnDef<DataTableFeatures, UnmatchedDepletionDto>[] {
  return [
    {
      id: 'title',
      accessorKey: 'title',
      header: 'Order line',
      cell: ({ row }) => (
        <Link
          to='/commerce/orders/$id'
          params={{ id: row.original.orderId }}
          className='font-medium hover:underline'
        >
          {row.original.title ?? row.original.orderLineId}
        </Link>
      )
    },
    {
      id: 'quantityFulfilled',
      accessorKey: 'quantityFulfilled',
      header: () => <div className='text-right'>Qty fulfilled</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatQuantity(Number(row.original.quantityFulfilled))}
        </div>
      )
    },
    {
      id: 'lineTotal',
      accessorKey: 'lineTotal',
      header: () => <div className='text-right'>Line total</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.lineTotal, row.original.currency)}
        </div>
      )
    }
  ];
}

/**
 * Fulfilled order lines with no matching depletion movement — NOT a failure
 * mode (the design is emphatic: this is the common early-Phase-4 case), so
 * the non-empty state renders as a plain worklist, not an alarm.
 */
export default function UnmatchedDepletionsWorklist({ rows }: { rows: UnmatchedDepletionDto[] }) {
  const table = useTable({
    data: rows,
    columns: buildColumns(),
    features: dataTableFeatures,
    getRowId: (row) => row.orderLineId,
    manualPagination: true
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Unmatched depletions</CardTitle>
        <CardDescription>
          Fulfilled order lines with no stock depletion recorded against them — not an error, the
          common backlog while inventory tracking catches up to sales.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.refunds />
              </EmptyMedia>
              <EmptyTitle>Nothing unmatched</EmptyTitle>
              <EmptyDescription>
                Every fulfilled order line has a matching stock depletion.
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
