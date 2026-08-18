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
import { formatMoney } from '@/lib/format';
import type { UnlinkedShippingLabelFeeDto } from '@/server/inventory-functions';

function buildColumns(): ColumnDef<DataTableFeatures, UnlinkedShippingLabelFeeDto>[] {
  return [
    {
      id: 'orderId',
      accessorKey: 'orderId',
      header: 'Order',
      cell: ({ row }) => (
        <Link
          to='/commerce/orders/$id'
          params={{ id: row.original.orderId }}
          className='font-medium hover:underline'
        >
          View order
        </Link>
      )
    },
    {
      id: 'amount',
      accessorKey: 'amount',
      header: () => <div className='text-right'>Fee amount</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.amount, row.original.currency)}
        </div>
      )
    }
  ];
}

/**
 * `ShipmentsService.unlinkedShippingLabelFees` (loxep-7fs, A14) — the
 * design's recommended reconciliation for the shipping double-count guard:
 * a `shipping_label_charge` seller fee with no shipment's `order_fee_id`
 * pointing at it is a silent double-count risk sitting in every
 * profitability figure above. Fix a row by recording (or linking) the
 * matching shipment on that order's detail page.
 */
export default function UnlinkedShippingLabelFeesWorklist({
  rows
}: {
  rows: UnlinkedShippingLabelFeeDto[];
}) {
  const table = useTable({
    data: rows,
    columns: buildColumns(),
    features: dataTableFeatures,
    getRowId: (row) => row.orderFeeId,
    manualPagination: true
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Unlinked shipping label fees</CardTitle>
        <CardDescription>
          A shipping-label fee with no shipment recorded against it — a silent double-count risk
          until an operator records the matching shipment.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.check />
              </EmptyMedia>
              <EmptyTitle>Nothing unlinked</EmptyTitle>
              <EmptyDescription>
                Every shipping-label fee has a shipment recorded against it.
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
