import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { DockhandStackDto } from '@/server/infrastructure-functions';

/**
 * Dockhand documents this as a closed set (`running | stopped | partial |
 * created`) but the adapter carries it verbatim anyway — an unversioned API
 * may add a fifth value, and an unrecognized one falls through to the
 * neutral `outline` tone rather than being rejected.
 */
const STACK_STATUS_TONE: Record<string, Tone> = {
  running: 'success',
  partial: 'warning',
  created: 'outline',
  stopped: 'destructive'
};

export const dockhandStackColumns: ColumnDef<DataTableFeatures, DockhandStackDto>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({ column }: { column: Column<DataTableFeatures, DockhandStackDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Name' />
    ),
    cell: ({ row }) => <span className='font-medium'>{row.original.name}</span>,
    meta: {
      label: 'Name',
      placeholder: 'Search stacks...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: ({ column }: { column: Column<DataTableFeatures, DockhandStackDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Status' />
    ),
    cell: ({ row }) => {
      const status = row.original.status;
      return (
        <ToneBadge tone={STACK_STATUS_TONE[status] ?? 'outline'}>{status || 'unknown'}</ToneBadge>
      );
    }
  },
  {
    id: 'sourceType',
    header: 'Source',
    cell: ({ row }) => (
      <span className='text-muted-foreground text-sm'>{row.original.sourceType ?? '—'}</span>
    )
  },
  {
    id: 'containers',
    header: 'Containers',
    cell: ({ row }) => (
      <span className='tabular-nums'>
        {row.original.runningContainerCount} / {row.original.containerCount} running
      </span>
    )
  }
];
