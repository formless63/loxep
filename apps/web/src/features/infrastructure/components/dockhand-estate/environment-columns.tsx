import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import {
  dockhandEstateEnvironmentsQuery,
  discoveredFleetResourcesQuery,
  hostingTargetsQuery,
  infrastructureOverviewQuery
} from '@/features/infrastructure/api/queries';
import { adoptContainerHostAsHostingTarget } from '@/server/infrastructure-functions';
import type { DockhandEstateEnvironmentDto } from '@/server/dockhand-estate-functions';

/**
 * The Loxep cross-reference cell (Rule P16): a LINKED environment links OUT
 * to its fleet-detail page — this estate page never re-renders that panel.
 * An UNMATCHED environment gets the one write this page mounts (Rule P10/
 * P11): `adoptContainerHostAsHostingTarget`, the EXACT server function
 * `/infrastructure/overview`'s `UnmatchedContainerHostsCard` already calls —
 * no new verb, no new payload shape. An `'unknown'` environment (no
 * `external_resources` row yet — discovery has not run) offers nothing,
 * honestly, rather than guessing.
 */
function LoxepCell({
  connectionId,
  row
}: {
  connectionId: string;
  row: DockhandEstateEnvironmentDto;
}) {
  const queryClient = useQueryClient();
  const adoptMutation = useMutation({
    mutationFn: (externalResourceId: string) =>
      adoptContainerHostAsHostingTarget({ data: { externalResourceId } }),
    onSuccess: async (result) => {
      toast.success(`Adopted as hosting target "${result.name}"`);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: dockhandEstateEnvironmentsQuery(connectionId).queryKey
        }),
        queryClient.invalidateQueries({
          queryKey: discoveredFleetResourcesQuery('dockhand').queryKey
        }),
        queryClient.invalidateQueries({ queryKey: hostingTargetsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: infrastructureOverviewQuery.queryKey })
      ]);
    },
    onError: (error) => toastError(error, 'Failed to adopt this environment')
  });

  if (row.crossReference.kind === 'linked') {
    return (
      <Button size='sm' variant='link' className='h-auto p-0' asChild>
        <Link
          to='/infrastructure/fleet/$name'
          params={{ name: row.crossReference.hostingTargetName }}
        >
          <Icons.circleCheck className='mr-1 h-3.5 w-3.5' /> {row.crossReference.hostingTargetName}
        </Link>
      </Button>
    );
  }
  if (row.crossReference.kind === 'unmatched') {
    const externalResourceId = row.crossReference.externalResourceId;
    return (
      <Button
        size='sm'
        variant='outline'
        disabled={adoptMutation.isPending}
        onClick={() => adoptMutation.mutate(externalResourceId)}
      >
        Adopt as hosting target
      </Button>
    );
  }
  return <span className='text-muted-foreground text-sm'>Not yet discovered</span>;
}

export function dockhandEnvironmentColumns(
  connectionId: string,
  onViewContainers: (environment: DockhandEstateEnvironmentDto) => void,
  selectedExternalHostId: string | null
): ColumnDef<DataTableFeatures, DockhandEstateEnvironmentDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, DockhandEstateEnvironmentDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Environment' />,
      cell: ({ row }) => <span className='font-medium'>{row.original.name}</span>,
      meta: {
        label: 'Environment',
        placeholder: 'Search environments...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'connection',
      header: 'Connection',
      cell: ({ row }) => (
        <div className='flex flex-col text-sm'>
          <span className='font-mono text-xs'>{row.original.connectionType}</span>
          <span className='text-muted-foreground'>
            {row.original.host !== null
              ? `${row.original.host}${row.original.port !== null ? `:${row.original.port}` : ''}`
              : (row.original.socketPath ?? '—')}
          </span>
        </div>
      )
    },
    {
      id: 'labels',
      header: 'Labels',
      cell: ({ row }) =>
        row.original.labels.length === 0 ? (
          <span className='text-muted-foreground'>—</span>
        ) : (
          <div className='flex flex-wrap gap-1'>
            {row.original.labels.map((label) => (
              <Badge key={label} variant='outline'>
                {label}
              </Badge>
            ))}
          </div>
        )
    },
    {
      id: 'hawser',
      header: 'Hawser agent',
      cell: ({ row }) =>
        row.original.hawserConfigured ? (
          <span className='text-sm'>
            {row.original.hawserLastSeen !== null
              ? `seen ${formatRelativeTime(row.original.hawserLastSeen)}`
              : 'configured, never seen'}
          </span>
        ) : (
          <span className='text-muted-foreground text-sm'>not configured</span>
        )
    },
    {
      id: 'loxep',
      header: 'In Loxep',
      cell: ({ row }) => <LoxepCell connectionId={connectionId} row={row.original} />
    },
    {
      id: 'containers',
      header: 'Containers',
      cell: ({ row }) => {
        const isOpen = selectedExternalHostId === row.original.externalHostId;
        return (
          <Button
            size='sm'
            variant={isOpen ? 'default' : 'outline'}
            onClick={() => onViewContainers(row.original)}
          >
            {isOpen ? 'Hide containers' : 'View containers'}
          </Button>
        );
      }
    }
  ];
}
