import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
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
import type { OnHandAtCostDto } from '@/server/inventory-functions';

function buildColumns(): ColumnDef<DataTableFeatures, OnHandAtCostDto>[] {
  return [
    {
      id: 'locationPath',
      accessorKey: 'locationPath',
      header: 'Location',
      cell: ({ row }) => (
        <span className={row.original.locationPath ? undefined : 'text-muted-foreground'}>
          {row.original.locationPath ?? 'Unassigned'}
        </span>
      )
    },
    {
      id: 'currency',
      accessorKey: 'currency',
      header: () => <div className='text-right'>Currency</div>,
      cell: ({ row }) => (
        <div className='text-right text-muted-foreground'>{row.original.currency}</div>
      )
    },
    {
      id: 'itemCount',
      accessorKey: 'itemCount',
      header: () => <div className='text-right'>Items</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>{formatQuantity(row.original.itemCount)}</div>
      )
    },
    {
      id: 'quantityOnHand',
      accessorKey: 'quantityOnHand',
      header: () => <div className='text-right'>Qty on hand</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatQuantity(Number(row.original.quantityOnHand))}
        </div>
      )
    },
    {
      id: 'onHandCostAmount',
      accessorKey: 'onHandCostAmount',
      header: () => <div className='text-right'>On-hand cost</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.onHandCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'consignmentItemCount',
      accessorKey: 'consignmentItemCount',
      header: () => <div className='text-right'>Consignment</div>,
      cell: ({ row }) =>
        row.original.consignmentItemCount > 0 ? (
          <div className='text-right'>
            <Badge variant='secondary' title='Held, not owned — excluded from the cost total above'>
              {formatQuantity(row.original.consignmentItemCount)} held
            </Badge>
          </div>
        ) : (
          <div className='text-right text-muted-foreground'>—</div>
        )
    }
  ];
}

/**
 * Stock on hand AT COST — explicitly not a valuation (see
 * `inventoryOnHandAtCost`'s own module doc). Fixed, unfiltered read model;
 * local `useTable` table, same as `SourcingChannelTable`.
 */
export default function OnHandAtCostTable({ rows }: { rows: OnHandAtCostDto[] }) {
  const table = useTable({
    data: rows,
    columns: buildColumns(),
    features: dataTableFeatures,
    getRowId: (row) =>
      `${row.locationId ?? 'none'}|${row.economicEntityId ?? 'none'}|${row.currency}`,
    manualPagination: true
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>On hand, at cost</CardTitle>
        <CardDescription>
          A COST total, not a valuation — what was paid for stock still on the shelf, by location.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.product />
              </EmptyMedia>
              <EmptyTitle>Nothing on hand</EmptyTitle>
              <EmptyDescription>No stock currently sits above zero quantity.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DataTable table={table} />
        )}
      </CardContent>
    </Card>
  );
}
