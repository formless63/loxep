import type { ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatQuantity, formatRelativeTime } from '@/lib/format';
import type { PendingProviderOperationDto } from '@/server/admin-functions';
import { ToneBadge } from '@/features/settings/components/status-tone';

export function getColumns(): ColumnDef<DataTableFeatures, PendingProviderOperationDto>[] {
  return [
    {
      id: 'status',
      header: 'Status',
      // Every row here is `pending` by construction (this table only ever
      // queries `listPending()`) — the badge is still rendered per-row so
      // the tone/icon convention holds and the column reads consistently
      // with `jobs-table`'s identical "Reason" column just above it on this
      // same page.
      cell: () => <ToneBadge tone='warning'>Pending</ToneBadge>
    },
    {
      id: 'provider',
      accessorKey: 'provider',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Provider' />,
      cell: ({ row }) => <span className='capitalize'>{row.original.provider}</span>,
      enableColumnFilter: true,
      meta: { label: 'Provider', variant: 'text', placeholder: 'Filter by provider…' }
    },
    {
      id: 'operation',
      accessorKey: 'operation',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Operation' />,
      cell: ({ row }) => <span className='font-mono text-xs'>{row.original.operation}</span>,
      enableColumnFilter: true,
      meta: { label: 'Operation', variant: 'text', placeholder: 'Filter by operation…' }
    },
    {
      id: 'idempotencyKey',
      accessorKey: 'idempotencyKey',
      header: 'Idempotency key',
      cell: ({ row }) => (
        <span
          className='block max-w-96 truncate font-mono text-xs'
          title={row.original.idempotencyKey}
        >
          {row.original.idempotencyKey}
        </span>
      )
    },
    {
      id: 'runSubject',
      header: 'Run subject',
      cell: ({ row }) => {
        const { runSubjectType, runSubjectId } = row.original;
        if (runSubjectType === null || runSubjectId === null) {
          return <span className='text-muted-foreground'>—</span>;
        }
        return (
          <span className='text-muted-foreground text-xs' title={runSubjectId}>
            {runSubjectType} · {runSubjectId.slice(0, 8)}
          </span>
        );
      }
    },
    {
      id: 'attempts',
      accessorKey: 'attempts',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Attempts' />,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>{formatQuantity(row.original.attempts)}</div>
      )
    },
    {
      id: 'startedAt',
      accessorKey: 'startedAt',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Age' />,
      cell: ({ row }) => (
        <span
          className='text-muted-foreground text-xs tabular-nums'
          title={formatDateTime(row.original.startedAt)}
        >
          {formatRelativeTime(row.original.startedAt)}
        </span>
      )
    }
  ];
}
