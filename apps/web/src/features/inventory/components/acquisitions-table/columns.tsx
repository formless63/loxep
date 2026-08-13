import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate } from '@/lib/format';
import type { AcquisitionListItemDto } from '@/server/inventory-functions';
import {
  acquisitionSourceKindLabel,
  acquisitionSourceKindOptions,
  acquisitionStatusLabel,
  acquisitionStatusOptions,
  acquisitionStatusTone,
  costAllocationStatusLabel,
  costAllocationStatusTone
} from '@/features/inventory/constants';

export const columns: ColumnDef<DataTableFeatures, AcquisitionListItemDto>[] = [
  {
    id: 'referenceCode',
    accessorKey: 'referenceCode',
    header: 'Lot',
    cell: ({ row }) => (
      <Link
        to='/inventory/acquisitions/$id'
        params={{ id: row.original.id }}
        className='font-medium hover:underline'
      >
        {row.original.referenceCode}
      </Link>
    )
  },
  {
    id: 'title',
    accessorKey: 'title',
    enableSorting: false,
    header: 'Title',
    cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>
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
    meta: {
      label: 'Source',
      variant: 'select' as const,
      options: acquisitionSourceKindOptions
    }
  },
  {
    id: 'vendorName',
    accessorKey: 'vendorName',
    enableSorting: false,
    header: 'Vendor',
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
    )
  },
  {
    id: 'status',
    accessorKey: 'status',
    enableSorting: false,
    header: 'Status',
    cell: ({ cell }) => {
      const status = cell.getValue<string>();
      return (
        <Badge variant={acquisitionStatusTone(status)}>{acquisitionStatusLabel(status)}</Badge>
      );
    },
    enableColumnFilter: true,
    meta: {
      label: 'Status',
      variant: 'select' as const,
      options: acquisitionStatusOptions
    }
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
    id: 'itemCount',
    accessorKey: 'itemCount',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, AcquisitionListItemDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Items' />,
    cell: ({ cell }) => <div className='text-right tabular-nums'>{cell.getValue<number>()}</div>
  },
  {
    id: 'acquiredAt',
    accessorKey: 'acquiredAt',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, AcquisitionListItemDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Acquired' />,
    cell: ({ cell }) => (
      <span className='text-muted-foreground tabular-nums'>
        {formatDate(cell.getValue<string>())}
      </span>
    )
  }
];

export const columnIds = columns.map((column) => column.id).filter(Boolean) as string[];
