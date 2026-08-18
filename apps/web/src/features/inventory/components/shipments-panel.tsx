import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { Icons } from '@/components/icons';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatMoney } from '@/lib/format';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { shipmentsForOrderQuery } from '@/features/inventory/api/queries';
import RecordShipmentDialog, {
  type RecordShipmentOrderLine
} from '@/features/inventory/components/record-shipment-dialog';
import RecordShipmentCostAdjustmentDialog from '@/features/inventory/components/record-shipment-cost-adjustment-dialog';
import type { ShipmentDto } from '@/server/inventory-functions';

function buildColumns(
  onAdjust: (shipment: ShipmentDto) => void
): ColumnDef<DataTableFeatures, ShipmentDto>[] {
  return [
    {
      id: 'carrier',
      accessorKey: 'carrierName',
      header: 'Carrier',
      cell: ({ row }) => (
        <div>
          <span className='font-medium'>{row.original.carrierName ?? 'Unspecified'}</span>
          {row.original.trackingNumber && (
            <span className='text-muted-foreground block text-xs'>
              {row.original.trackingNumber}
            </span>
          )}
        </div>
      )
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant='outline'>{row.original.status}</Badge>
    },
    {
      id: 'postageAmount',
      accessorKey: 'postageAmount',
      header: () => <div className='text-right'>Postage</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.postageAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'adjustmentAmount',
      accessorKey: 'adjustmentAmount',
      header: () => <div className='text-right'>Adjustments</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.adjustmentAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'refundAmount',
      accessorKey: 'refundAmount',
      header: () => <div className='text-right'>Refunds</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.refundAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'netCostAmount',
      accessorKey: 'netCostAmount',
      header: () => <div className='text-right'>Net cost</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.netCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'shippedAt',
      accessorKey: 'shippedAt',
      header: 'Shipped',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {row.original.shippedAt ? formatDateTime(row.original.shippedAt) : 'Not yet shipped'}
        </span>
      )
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <Button variant='ghost' size='sm' onClick={() => onAdjust(row.original)}>
          <Icons.adjustments className='size-3.5' />
          Adjust
        </Button>
      )
    }
  ];
}

/**
 * `ShipmentsService` (loxep-7fs, A14) — dead in its entirety before this
 * pass. Outbound carrier reality for one order: record a shipment, and
 * record a cost adjustment (carrier reweigh / label refund) against one
 * already recorded.
 */
export default function ShipmentsPanel({
  orderId,
  currency,
  lines
}: {
  orderId: string;
  currency: string;
  lines: RecordShipmentOrderLine[];
}) {
  const { data, isPending, isError, error, refetch } = useQuery(shipmentsForOrderQuery(orderId));
  const [recordOpen, setRecordOpen] = React.useState(false);
  const [adjusting, setAdjusting] = React.useState<ShipmentDto | null>(null);

  const columns = React.useMemo(() => buildColumns(setAdjusting), []);

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-2'>
        <CardTitle className='flex items-center gap-2 text-base'>
          <Icons.send className='size-4' /> Shipments
        </CardTitle>
        <Button size='sm' variant='outline' onClick={() => setRecordOpen(true)}>
          <Icons.add />
          Record shipment
        </Button>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <p className='text-muted-foreground text-sm'>Loading…</p>
        ) : isError ? (
          <QueryErrorAlert
            error={error}
            title='Could not load shipments'
            onRetry={() => refetch()}
          />
        ) : data.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.send />
              </EmptyMedia>
              <EmptyTitle>No shipments recorded</EmptyTitle>
              <EmptyDescription>
                Outbound carrier reality — what the carrier and we actually did, distinct from what
                the channel reported. Actual shipping cost is missing from every margin figure until
                a shipment exists.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button size='sm' onClick={() => setRecordOpen(true)}>
                <Icons.add />
                Record shipment
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ShipmentsDataTable rows={data} columns={columns} />
        )}
      </CardContent>

      <RecordShipmentDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        orderId={orderId}
        currency={currency}
        lines={lines}
      />
      {adjusting && (
        <RecordShipmentCostAdjustmentDialog
          open={adjusting !== null}
          onOpenChange={(next) => !next && setAdjusting(null)}
          shipmentId={adjusting.id}
          orderId={orderId}
          currency={adjusting.currency}
        />
      )}
    </Card>
  );
}

function ShipmentsDataTable({
  rows,
  columns
}: {
  rows: ShipmentDto[];
  columns: ColumnDef<DataTableFeatures, ShipmentDto>[];
}) {
  const table = useTable({
    data: rows,
    columns,
    features: dataTableFeatures,
    getRowId: (row) => row.id,
    manualPagination: true
  });
  return <DataTable table={table} />;
}
