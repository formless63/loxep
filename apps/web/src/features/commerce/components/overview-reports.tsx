import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table/data-table';
import { Icons } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatMoney, formatQuantity } from '@/lib/format';
import { commerceOverviewReportsQuery } from '@/features/commerce/api/queries';
import type { EntityAttributionGroupDto, OrderSummaryGroupDto } from '@/server/commerce-functions';

function summaryColumns(): ColumnDef<DataTableFeatures, OrderSummaryGroupDto>[] {
  return [
    {
      id: 'currency',
      accessorKey: 'currency',
      header: 'Currency',
      cell: ({ row }) => <span className='font-medium'>{row.original.currency}</span>
    },
    {
      id: 'orderCount',
      accessorKey: 'orderCount',
      header: () => <div className='text-right'>Orders</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>{formatQuantity(row.original.orderCount)}</div>
      )
    },
    {
      id: 'grossAmount',
      accessorKey: 'grossAmount',
      header: () => <div className='text-right'>Gross</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.grossAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'feeAmount',
      accessorKey: 'feeAmount',
      header: () => <div className='text-right'>Fees</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.feeAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'refundedAmount',
      accessorKey: 'refundedAmount',
      header: () => <div className='text-right'>Refunded</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.refundedAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'netAmount',
      accessorKey: 'netAmount',
      header: () => <div className='text-right'>Net</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.netAmount, row.original.currency)}
        </div>
      )
    }
  ];
}

function attributionColumns(): ColumnDef<DataTableFeatures, EntityAttributionGroupDto>[] {
  return [
    {
      id: 'economicEntityName',
      accessorKey: 'economicEntityName',
      header: 'Entity',
      cell: ({ row }) => (
        <span className={row.original.economicEntityName ? 'font-medium' : 'text-muted-foreground'}>
          {row.original.economicEntityName ?? 'Unattributed'}
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
      id: 'orderCount',
      accessorKey: 'orderCount',
      header: () => <div className='text-right'>Orders</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>{formatQuantity(row.original.orderCount)}</div>
      )
    },
    {
      id: 'grossAmount',
      accessorKey: 'grossAmount',
      header: () => <div className='text-right'>Gross</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.grossAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'netAmount',
      accessorKey: 'netAmount',
      header: () => <div className='text-right'>Net</div>,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.netAmount, row.original.currency)}
        </div>
      )
    }
  ];
}

/**
 * `orderSummary`/`entityAttributionReport` (loxep-7fs, A22) — finished read
 * models with zero callers before this pass; `/commerce/overview` rendered
 * only list-length stat cards. Both group by currency (never summed across),
 * and the unattributed row in the attribution table is reported, never
 * hidden — the same posture `entityAttributionReport`'s own doc names.
 */
export default function CommerceOverviewReports() {
  const { data, isPending, isError } = useQuery(commerceOverviewReportsQuery);

  if (isPending) {
    return (
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <Skeleton className='h-56 w-full' />
        <Skeleton className='h-56 w-full' />
      </div>
    );
  }
  if (isError) {
    return (
      <Alert variant='destructive'>
        <AlertTitle>Reports unavailable</AlertTitle>
        <AlertDescription>Could not load the revenue and attribution reports.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Revenue by currency</CardTitle>
          <CardDescription className='flex items-start gap-1.5'>
            <Icons.info className='mt-0.5 size-3.5 shrink-0' />
            <span>Net is {data.contributionLabel} — never &ldquo;profit&rdquo;.</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.orderSummary.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No orders yet.</p>
          ) : (
            <SummaryTable rows={data.orderSummary} />
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Attribution</CardTitle>
          <CardDescription>
            Which economic entity each order belongs to — the unattributed backlog is reported, not
            hidden.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.entityAttribution.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No orders yet.</p>
          ) : (
            <AttributionTable rows={data.entityAttribution} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryTable({ rows }: { rows: OrderSummaryGroupDto[] }) {
  const table = useTable({
    data: rows,
    columns: summaryColumns(),
    features: dataTableFeatures,
    getRowId: (row) => row.currency,
    manualPagination: true
  });
  return <DataTable table={table} />;
}

function AttributionTable({ rows }: { rows: EntityAttributionGroupDto[] }) {
  const table = useTable({
    data: rows,
    columns: attributionColumns(),
    features: dataTableFeatures,
    getRowId: (row) => `${row.economicEntityId ?? 'none'}|${row.currency}`,
    manualPagination: true
  });
  return <DataTable table={table} />;
}
