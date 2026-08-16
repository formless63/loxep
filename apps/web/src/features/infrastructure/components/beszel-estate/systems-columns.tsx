import type { ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { BeszelEstateSystemDto } from '@/server/beszel-estate-functions';

export interface BeszelSystemsColumnHandlers {
  onAttach: (system: BeszelEstateSystemDto) => void;
}

/**
 * Beszel systems columns (Estate Browsers Design §3.5) — `status` renders
 * the hub's own string VERBATIM (Rule P3): Beszel publishes no enumeration
 * beyond the documented `"up"`, so this never maps onto a Loxep-coined
 * healthy/unhealthy verdict or a colored tone.
 */
export function beszelSystemsColumns(
  handlers: BeszelSystemsColumnHandlers
): ColumnDef<DataTableFeatures, BeszelEstateSystemDto>[] {
  return [
    {
      id: 'name',
      header: 'System',
      cell: ({ row }) => (
        <span className='font-medium'>
          {row.original.name ?? row.original.host ?? row.original.externalSystemId}
        </span>
      )
    },
    {
      id: 'host',
      header: 'Host',
      cell: ({ row }) => (
        <span className='text-muted-foreground font-mono text-sm'>{row.original.host ?? '—'}</span>
      )
    },
    {
      id: 'port',
      header: 'Port',
      cell: ({ row }) => (
        <span className='text-muted-foreground font-mono text-sm'>{row.original.port ?? '—'}</span>
      )
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <span className='text-sm'>{row.original.status === '' ? '—' : row.original.status}</span>
      )
    },
    {
      id: 'updated',
      header: 'Updated',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>
          {row.original.observedAt ? formatRelativeTime(row.original.observedAt) : '—'}
        </span>
      )
    },
    {
      id: 'sharedWith',
      header: 'Shared with',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>{row.original.sharedWithCount}</span>
      )
    },
    {
      id: 'loxep',
      header: '',
      cell: ({ row }) => {
        const system = row.original;
        if (system.linked !== null) {
          return (
            <Link
              to='/infrastructure/fleet/$name'
              params={{ name: system.linked.hostingTargetName }}
              className='text-sm underline-offset-4 hover:underline'
            >
              Linked to {system.linked.hostingTargetName}
            </Link>
          );
        }
        return (
          <Button
            size='sm'
            variant='outline'
            disabled={system.externalResourceId === null}
            onClick={() => handlers.onAttach(system)}
          >
            Attach
          </Button>
        );
      }
    }
  ];
}
