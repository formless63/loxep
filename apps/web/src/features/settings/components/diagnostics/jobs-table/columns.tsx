import type { ColumnDef } from '@tanstack/react-table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDateTime, formatQuantity } from '@/lib/format';
import type { JobDiagnosticBucket, JobDiagnosticRowDto } from '@/server/diagnostics-functions';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { CellAction } from './cell-action';

const BUCKET_LABELS: Record<JobDiagnosticBucket, string> = {
  failed: 'Failed',
  pending: 'Stuck pending'
};

const BUCKET_TONE = {
  failed: 'destructive',
  pending: 'warning'
} as const satisfies Record<JobDiagnosticBucket, Tone>;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function getColumns(): ColumnDef<DataTableFeatures, JobDiagnosticRowDto>[] {
  return [
    {
      id: 'bucket',
      accessorKey: 'bucket',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Reason' />,
      cell: ({ row }) => (
        <ToneBadge tone={BUCKET_TONE[row.original.bucket]}>
          {BUCKET_LABELS[row.original.bucket]}
        </ToneBadge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Reason',
        variant: 'multiSelect',
        options: (Object.keys(BUCKET_LABELS) as JobDiagnosticBucket[]).map((value) => ({
          value,
          label: BUCKET_LABELS[value]
        }))
      }
    },
    {
      id: 'taskIdentifier',
      accessorKey: 'taskIdentifier',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Task' />,
      cell: ({ row }) => <span className='font-mono text-xs'>{row.original.taskIdentifier}</span>,
      enableColumnFilter: true,
      meta: { label: 'Task', variant: 'text', placeholder: 'Filter by task…' }
    },
    {
      id: 'attempts',
      accessorKey: 'attempts',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Attempts' />,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatQuantity(row.original.attempts)} / {formatQuantity(row.original.maxAttempts)}
        </div>
      )
    },
    {
      id: 'lastError',
      accessorKey: 'lastError',
      header: 'Last error',
      cell: ({ row }) => {
        const error = row.original.lastError;
        if (error === null) return <span className='text-muted-foreground'>—</span>;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className='text-destructive block max-w-80 truncate text-xs'>
                {truncate(error, 96)}
              </span>
            </TooltipTrigger>
            <TooltipContent className='max-w-96 whitespace-pre-wrap'>{error}</TooltipContent>
          </Tooltip>
        );
      }
    },
    {
      id: 'runAt',
      accessorKey: 'runAt',
      header: ({ column }) => <DataTableColumnHeader column={column} title='Run at' />,
      cell: ({ row }) => (
        <span className='text-muted-foreground text-xs'>{formatDateTime(row.original.runAt)}</span>
      )
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => <CellAction data={row.original} />
    }
  ];
}
