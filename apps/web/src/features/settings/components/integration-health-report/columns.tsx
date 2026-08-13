import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { IntegrationHealthDto } from '@/server/admin-functions';

/** Design's closed status set — no `stale` value; staleness is derived below. */
const STATUS_TONE: Record<string, Tone> = {
  ok: 'success',
  degraded: 'warning',
  failing: 'destructive',
  unknown: 'outline'
};

export const integrationHealthColumns: ColumnDef<DataTableFeatures, IntegrationHealthDto>[] = [
  {
    id: 'subjectType',
    accessorKey: 'subjectType',
    header: ({ column }: { column: Column<DataTableFeatures, IntegrationHealthDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Subject type' />
    ),
    cell: ({ cell }) => (
      <span className='capitalize'>{cell.getValue<string>().replaceAll('_', ' ')}</span>
    ),
    meta: {
      label: 'Subject type',
      variant: 'multiSelect' as const,
      icon: Icons.text,
      options: ['connection', 'notification_endpoint', 'storage_backend'].map((value) => ({
        label: value.replaceAll('_', ' '),
        value
      }))
    },
    enableColumnFilter: true
  },
  {
    id: 'label',
    accessorKey: 'label',
    header: ({ column }: { column: Column<DataTableFeatures, IntegrationHealthDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Subject' />
    ),
    cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
    meta: {
      label: 'Subject',
      placeholder: 'Search subjects...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: ({ column }: { column: Column<DataTableFeatures, IntegrationHealthDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Status' />
    ),
    cell: ({ cell }) => {
      const status = cell.getValue<string>();
      return <ToneBadge tone={STATUS_TONE[status] ?? 'outline'}>{status}</ToneBadge>;
    }
  },
  {
    id: 'source',
    accessorKey: 'source',
    header: ({ column }: { column: Column<DataTableFeatures, IntegrationHealthDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Source' />
    ),
    cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>
  },
  {
    id: 'checkedAt',
    header: 'Last checked',
    cell: ({ row }) => (
      <span title={formatDateTime(row.original.checkedAt)}>
        {formatRelativeTime(row.original.checkedAt)}
      </span>
    )
  },
  {
    id: 'statusChangedAt',
    header: 'Changed',
    cell: ({ row }) => {
      const { statusChangedAt, previousStatus } = row.original;
      if (!statusChangedAt) {
        return <span className='text-muted-foreground'>—</span>;
      }
      const title = previousStatus
        ? `${formatDateTime(statusChangedAt)} — was ${previousStatus}`
        : formatDateTime(statusChangedAt);
      return <span title={title}>{formatRelativeTime(statusChangedAt)}</span>;
    }
  },
  {
    id: 'consecutiveFailures',
    header: 'Failure streak',
    cell: ({ row }) => {
      const streak = row.original.consecutiveFailures;
      return streak > 0 ? (
        <ToneBadge tone='destructive'>{streak}</ToneBadge>
      ) : (
        <span className='text-muted-foreground'>—</span>
      );
    }
  }
];
