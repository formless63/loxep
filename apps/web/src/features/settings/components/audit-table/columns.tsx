import type { ColumnDef } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatTimestampPrecise } from '@/lib/format';
import type { AuditEventDto } from '@/server/audit-functions';
import { AuditDiffSheet } from './audit-diff-view';

export interface AuditActorOption {
  value: string;
  label: string;
}

/**
 * Every column is `enableSorting: false` — `AuditReader.list` always orders
 * `occurred_at desc` (newest first, the one order this ledger is meant to be
 * read in) and takes no sort parameter, so a sortable header here would
 * silently do nothing (Frontend Standards forbids a column that LOOKS
 * sortable but only reorders the current page).
 */
export function createColumns(
  actorOptions: AuditActorOption[]
): ColumnDef<DataTableFeatures, AuditEventDto>[] {
  return [
    {
      id: 'occurredAt',
      accessorKey: 'occurredAt',
      enableSorting: false,
      header: 'Time',
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatTimestampPrecise(cell.getValue<string>())}
        </span>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Occurred',
        variant: 'dateRange' as const,
        icon: Icons.calendar
      }
    },
    {
      id: 'actorUserId',
      accessorKey: 'actorDisplayName',
      enableSorting: false,
      header: 'Actor',
      cell: ({ row }) => <span>{row.original.actorDisplayName}</span>,
      enableColumnFilter: true,
      meta: {
        label: 'Actor',
        variant: 'select' as const,
        options: actorOptions,
        icon: Icons.user
      }
    },
    {
      id: 'action',
      accessorKey: 'action',
      enableSorting: false,
      header: 'Action',
      cell: ({ cell }) => <span className='font-mono text-xs'>{cell.getValue<string>()}</span>,
      enableColumnFilter: true,
      meta: {
        label: 'Action',
        placeholder: 'Search action…',
        variant: 'text' as const,
        icon: Icons.search
      }
    },
    {
      id: 'resourceType',
      accessorKey: 'resourceType',
      enableSorting: false,
      header: 'Resource',
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span>{row.original.resourceType}</span>
          {row.original.resourceId && (
            <span className='max-w-[16ch] truncate font-mono text-xs text-muted-foreground'>
              {row.original.resourceId}
            </span>
          )}
        </div>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Resource type',
        placeholder: 'Search resource type…',
        variant: 'text' as const,
        icon: Icons.search
      }
    },
    {
      id: 'diff',
      header: '',
      enableSorting: false,
      cell: ({ row }) => (
        <AuditDiffSheet
          event={row.original}
          trigger={
            <Button
              type='button'
              variant='ghost'
              size='icon'
              aria-label={`View diff for ${row.original.action}`}
              title='View before/after diff'
            >
              <Icons.code />
            </Button>
          }
        />
      )
    }
  ];
}
