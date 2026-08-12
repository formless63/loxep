import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import { STORAGE_DRIVER_LABELS } from '@/features/settings/constants';
import type { StorageBackendDto } from '@/server/admin-functions';
import { CellAction } from './cell-action';

const DRIVER_OPTIONS = (
  Object.keys(STORAGE_DRIVER_LABELS) as (keyof typeof STORAGE_DRIVER_LABELS)[]
).map((value) => ({ value, label: STORAGE_DRIVER_LABELS[value] }));

function describeConfig(backend: StorageBackendDto): string {
  const config = backend.config as Record<string, unknown> | null;
  if (!config || typeof config !== 'object') return '—';
  if (backend.driver === 'local') {
    return typeof config.rootDir === 'string' ? config.rootDir : '—';
  }
  if (backend.driver === 's3') {
    const endpoint = typeof config.endpoint === 'string' ? config.endpoint : '?';
    const bucket = typeof config.bucket === 'string' ? config.bucket : '?';
    return `${endpoint} / ${bucket}`;
  }
  return '—';
}

export function getColumns(isAdmin: boolean): ColumnDef<StorageBackendDto>[] {
  const columns: ColumnDef<StorageBackendDto>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({ column }: { column: Column<StorageBackendDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ cell }) => <span className='font-medium'>{cell.getValue<string>()}</span>,
      meta: {
        label: 'Name',
        placeholder: 'Search backends...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'driver',
      accessorKey: 'driver',
      header: ({ column }: { column: Column<StorageBackendDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Driver' />
      ),
      cell: ({ row }) => (
        <Badge variant='outline'>
          {STORAGE_DRIVER_LABELS[row.original.driver as 'local' | 's3'] ?? row.original.driver}
        </Badge>
      ),
      enableColumnFilter: true,
      meta: { label: 'driver', variant: 'multiSelect' as const, options: DRIVER_OPTIONS }
    },
    {
      id: 'location',
      header: 'Location',
      cell: ({ row }) => (
        <span className='text-muted-foreground max-w-xs truncate'>
          {describeConfig(row.original)}
        </span>
      )
    },
    {
      id: 'enabled',
      accessorKey: 'enabled',
      header: ({ column }: { column: Column<StorageBackendDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Enabled' />
      ),
      cell: ({ cell }) => (
        <BooleanStatusBadge
          value={cell.getValue<boolean>()}
          trueLabel='enabled'
          falseLabel='disabled'
          falseTone='warning'
        />
      )
    },
    {
      id: 'default',
      accessorKey: 'isDefault',
      header: 'Default',
      cell: ({ row }) =>
        row.original.isDefault ? (
          <Badge>default</Badge>
        ) : (
          <span className='text-muted-foreground'>—</span>
        )
    },
    {
      id: 'credentials',
      header: 'Credentials',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {row.original.driver === 's3'
            ? row.original.hasCredentials
              ? 'encrypted'
              : 'missing'
            : 'n/a'}
        </span>
      )
    }
  ];

  if (isAdmin) {
    columns.push({
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} />
    });
  }

  return columns;
}
