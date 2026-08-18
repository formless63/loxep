import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatMoney, formatQuantity } from '@/lib/format';
import type { AcquisitionRoiDto } from '@/server/inventory-functions';
import {
  acquisitionSourceKindLabel,
  acquisitionSourceKindOptions,
  costAllocationStatusLabel,
  costAllocationStatusTone
} from '@/features/inventory/constants';
import { ContributionInfo } from '@/features/inventory/components/profitability/contribution-note';

export function buildAcquisitionRoiColumns(
  contributionLabel: string
): ColumnDef<DataTableFeatures, AcquisitionRoiDto>[] {
  return [
    {
      id: 'referenceCode',
      accessorKey: 'referenceCode',
      header: 'Lot',
      cell: ({ row }) => (
        <Link
          to='/inventory/acquisitions/$id'
          params={{ id: row.original.acquisitionId }}
          className='font-medium hover:underline'
        >
          {row.original.referenceCode}
        </Link>
      )
    },
    {
      id: 'sourceKind',
      accessorKey: 'sourceKind',
      enableSorting: false,
      header: 'Source',
      cell: ({ cell }) => (
        <Badge variant='outline'>{acquisitionSourceKindLabel(cell.getValue<string>())}</Badge>
      ),
      enableColumnFilter: true,
      meta: { label: 'Source', variant: 'select' as const, options: acquisitionSourceKindOptions }
    },
    {
      id: 'costAllocationStatus',
      accessorKey: 'costAllocationStatus',
      enableSorting: false,
      header: 'Cost allocation',
      cell: ({ cell }) => (
        <Badge variant={costAllocationStatusTone(cell.getValue<string>())}>
          {costAllocationStatusLabel(cell.getValue<string>())}
        </Badge>
      )
    },
    {
      id: 'acquiredAt',
      header: ({ column }: { column: Column<DataTableFeatures, AcquisitionRoiDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Acquired' />
      ),
      accessorKey: 'acquiredAt',
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDate(cell.getValue<string>())}
        </span>
      )
    },
    {
      id: 'itemCount',
      accessorKey: 'itemCount',
      enableSorting: false,
      header: 'Items',
      cell: ({ row }) => (
        <div className='text-right text-sm tabular-nums'>
          <span>{formatQuantity(row.original.onHandItemCount)} on hand</span>
          <span className='text-muted-foreground'>
            {' '}
            &middot; {formatQuantity(row.original.depletedItemCount)} depleted
          </span>
        </div>
      )
    },
    {
      id: 'landedCostAmount',
      header: ({ column }: { column: Column<DataTableFeatures, AcquisitionRoiDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Landed cost' />
      ),
      accessorKey: 'landedCostAmount',
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.landedCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'onHandCostAmount',
      header: ({ column }: { column: Column<DataTableFeatures, AcquisitionRoiDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='On-hand cost' />
      ),
      accessorKey: 'onHandCostAmount',
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatMoney(row.original.onHandCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'realizedContributionAmount',
      header: ({ column }: { column: Column<DataTableFeatures, AcquisitionRoiDto, unknown> }) => (
        <div className='flex items-center justify-end gap-1'>
          <DataTableColumnHeader column={column} title='Realized contribution' />
          <ContributionInfo label={contributionLabel} />
        </div>
      ),
      accessorKey: 'realizedContributionAmount',
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.realizedContributionAmount, row.original.currency)}
        </div>
      )
    }
  ];
}

export const acquisitionRoiColumnIds = [
  'referenceCode',
  'sourceKind',
  'costAllocationStatus',
  'acquiredAt',
  'itemCount',
  'landedCostAmount',
  'onHandCostAmount',
  'realizedContributionAmount'
];
