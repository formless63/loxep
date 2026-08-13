import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { RUN_MODE_LABELS, RUN_STATUS_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatDateTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { ReconcileRunDto } from '@/server/infrastructure-functions';

const STATUS_OPTIONS = [
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'partial', label: 'Partial' }
];

export function getColumns(): ColumnDef<DataTableFeatures, ReconcileRunDto>[] {
  return [
    {
      id: 'kind',
      accessorKey: 'kind',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Run' />
      ),
      cell: ({ row }) => (
        <Link
          to='/infrastructure/runs/$id'
          params={{ id: row.original.id }}
          className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          {row.original.kind}
        </Link>
      ),
      meta: {
        label: 'Run',
        placeholder: 'Search runs...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'subject',
      header: 'Subject',
      cell: ({ row }) => (
        <span>
          {row.original.subjectLabel ?? row.original.subjectId}
          <span className='text-muted-foreground'> ({row.original.subjectType})</span>
        </span>
      )
    },
    {
      id: 'mode',
      accessorKey: 'mode',
      header: 'Mode',
      cell: ({ row }) => (
        <Badge variant='outline'>{RUN_MODE_LABELS[row.original.mode] ?? row.original.mode}</Badge>
      )
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Status' />
      ),
      cell: ({ row }) => (
        <ToneBadge tone={RUN_STATUS_TONE[row.original.status] ?? 'secondary'}>
          {row.original.status}
        </ToneBadge>
      ),
      enableColumnFilter: true,
      meta: { label: 'Status', variant: 'multiSelect' as const, options: STATUS_OPTIONS }
    },
    {
      id: 'startedAt',
      accessorKey: 'startedAt',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Started' />
      ),
      cell: ({ row }) => <span>{formatDateTime(row.original.startedAt)}</span>
    }
  ];
}
