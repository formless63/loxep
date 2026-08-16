import type { Column, ColumnDef } from '@tanstack/react-table';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { DockhandEstateContainerDto } from '@/server/dockhand-estate-functions';

/**
 * Docker's own container-state vocabulary, verbatim from `DockhandAdapter`
 * (Rule P3 — never re-enumerated by Loxep). Mirrors the shipped per-host
 * `DockhandContainersPanel`'s own tone map exactly, so a container reads the
 * same way on both pages.
 */
const CONTAINER_STATE_TONE: Record<string, Tone> = {
  running: 'success',
  created: 'outline',
  restarting: 'warning',
  paused: 'warning',
  exited: 'destructive',
  dead: 'destructive'
};

/**
 * NO lifecycle column exists here, ever (rule 13, absolute) — this table has
 * no action cell of any kind, matching `DockhandEstateContainerDto`'s own
 * shape, which carries no lifecycle field to act on.
 */
export const dockhandEstateContainerColumns: ColumnDef<
  DataTableFeatures,
  DockhandEstateContainerDto
>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, DockhandEstateContainerDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='Name' />,
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
    header: ({
      column
    }: {
      column: Column<DataTableFeatures, DockhandEstateContainerDto, unknown>;
    }) => <DataTableColumnHeader column={column} title='State' />,
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
