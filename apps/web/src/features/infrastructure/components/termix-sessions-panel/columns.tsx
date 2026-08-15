import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { TermixSessionRowDto } from '@/server/infrastructure-functions';

/**
 * One row per Termix active terminal session (loxep-4ah, owner-approved
 * per-session rows — the wvm design's who/where/age shapes). `sharedByUsername`
 * renders VERBATIM as the human it names — the owner's 2026-08-15 ruling is
 * that Termix is used by people who trust one another, so this is the
 * intended value, never redacted or generalized to a count.
 */
export const termixSessionColumns: ColumnDef<DataTableFeatures, TermixSessionRowDto>[] = [
  {
    id: 'who',
    accessorFn: (row) => (row.isOwnSession ? 'you' : (row.sharedByUsername ?? 'unknown')),
    header: ({ column }: { column: Column<DataTableFeatures, TermixSessionRowDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Who' />
    ),
    cell: ({ row }) => (
      <span className='font-medium'>
        {row.original.isOwnSession ? 'You' : (row.original.sharedByUsername ?? 'Unknown user')}
      </span>
    ),
    meta: {
      label: 'Who',
      placeholder: 'Search by user...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'where',
    header: 'Where',
    cell: ({ row }) => (
      <span className='text-muted-foreground text-sm'>
        {row.original.hostName ?? row.original.hostId}
      </span>
    )
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <ToneBadge tone={row.original.isConnected ? 'success' : 'outline'}>
        {row.original.isConnected ? 'connected' : 'idle'}
      </ToneBadge>
    )
  },
  {
    id: 'permission',
    header: 'Permission',
    cell: ({ row }) => (
      <span className='text-muted-foreground text-sm'>
        {row.original.permissionLevel ?? (row.original.isOwnSession ? 'owner' : '—')}
      </span>
    )
  },
  {
    id: 'age',
    header: ({ column }: { column: Column<DataTableFeatures, TermixSessionRowDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Age' />
    ),
    cell: ({ row }) => (
      <span className='text-muted-foreground text-sm tabular-nums'>
        {row.original.createdAt !== null ? formatRelativeTime(row.original.createdAt) : '—'}
      </span>
    )
  }
];
