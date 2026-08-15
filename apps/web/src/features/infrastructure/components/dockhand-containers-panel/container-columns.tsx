import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { DockhandContainerDto } from '@/server/infrastructure-functions';

/**
 * Docker's own container-state vocabulary, verbatim from `DockhandAdapter`
 * (never re-enumerated by Loxep — an unrecognized state falls through to the
 * neutral `outline` tone rather than being rejected). `ToneBadge` already
 * pairs every tone with its own icon (Frontend Standards: mono/notebook
 * themes carry no hue at all), so this map only ever needs a tone.
 */
const CONTAINER_STATE_TONE: Record<string, Tone> = {
  running: 'success',
  created: 'outline',
  restarting: 'warning',
  paused: 'warning',
  exited: 'destructive',
  dead: 'destructive'
};

export const dockhandContainerColumns: ColumnDef<DataTableFeatures, DockhandContainerDto>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({ column }: { column: Column<DataTableFeatures, DockhandContainerDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Name' />
    ),
    cell: ({ row }) => (
      <span className='font-medium'>{row.original.name ?? row.original.externalContainerId}</span>
    ),
    meta: {
      label: 'Name',
      placeholder: 'Search containers...',
      variant: 'text' as const,
      icon: Icons.text
    },
    enableColumnFilter: true
  },
  {
    id: 'image',
    accessorKey: 'image',
    header: 'Image',
    cell: ({ row }) => (
      <span className='text-muted-foreground font-mono text-xs'>{row.original.image ?? '—'}</span>
    )
  },
  {
    id: 'state',
    accessorKey: 'state',
    header: ({ column }: { column: Column<DataTableFeatures, DockhandContainerDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='State' />
    ),
    cell: ({ row }) => {
      const state = row.original.state;
      return (
        <ToneBadge tone={CONTAINER_STATE_TONE[state] ?? 'outline'}>{state || 'unknown'}</ToneBadge>
      );
    }
  },
  {
    id: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <span className='text-muted-foreground text-sm'>{row.original.status ?? '—'}</span>
    )
  }
];
