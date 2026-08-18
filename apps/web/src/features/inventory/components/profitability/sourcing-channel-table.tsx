import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
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
import type { SourcingChannelDto } from '@/server/inventory-functions';
import { acquisitionSourceKindLabel } from '@/features/inventory/constants';
import { ContributionInfo } from '@/features/inventory/components/profitability/contribution-note';

function buildColumns(
  contributionLabel: string
): ColumnDef<DataTableFeatures, SourcingChannelDto>[] {
  return [
    {
      id: 'sourceKind',
      accessorKey: 'sourceKind',
      header: 'Source',
      cell: ({ row }) => (
        <span className='font-medium'>{acquisitionSourceKindLabel(row.original.sourceKind)}</span>
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
      id: 'acquisitionCount',
      accessorKey: 'acquisitionCount',
      header: () => <div className='text-right'>Lots</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatQuantity(row.original.acquisitionCount)}
        </div>
      )
    },
    {
      id: 'landedCostAmount',
      accessorKey: 'landedCostAmount',
      header: () => <div className='text-right'>Landed cost</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.landedCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'onHandCostAmount',
      accessorKey: 'onHandCostAmount',
      header: () => <div className='text-right'>On-hand cost</div>,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.onHandCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'realizedContributionAmount',
      accessorKey: 'realizedContributionAmount',
      header: () => (
        <div className='flex items-center justify-end gap-1'>
          Realized contribution
          <ContributionInfo label={contributionLabel} />
        </div>
      ),
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.realizedContributionAmount, row.original.currency)}
        </div>
      )
    }
  ];
}

/**
 * "Is this channel worth repeating" — `sourcingChannelPerformance`,
 * grouped by source kind and currency. A fixed, unfiltered read model (small,
 * already-aggregated row set), so this is a local `useTable` + `dataTableFeatures`
 * table (the `book-trial-balance.tsx` shape), not the URL-synced primary table.
 */
export default function SourcingChannelTable({
  rows,
  contributionLabel
}: {
  rows: SourcingChannelDto[];
  contributionLabel: string;
}) {
  const table = useTable({
    data: rows,
    columns: buildColumns(contributionLabel),
    features: dataTableFeatures,
    getRowId: (row) => `${row.sourceKind}|${row.currency}`,
    manualPagination: true
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Sourcing channel performance</CardTitle>
        <CardDescription>
          Acquisition ROI grouped by how the lot was sourced — which channels are actually worth
          repeating.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.billing />
              </EmptyMedia>
              <EmptyTitle>No sourcing data yet</EmptyTitle>
              <EmptyDescription>
                Appears once an acquisition has depleted stock against a sale.
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
