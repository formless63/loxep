import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { RUN_MODE_LABELS, RUN_STATUS_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatDateTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { ReconcileRunDto } from '@/server/infrastructure-functions';

const STATUS_OPTIONS = [
  { value: 'running', label: 'Running' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'failed', label: 'Failed' },
  { value: 'partial', label: 'Partial' }
];

/** `reconcile_runs.trigger` — CLOSED and `CHECK`ed (`packages/db/src/schema/infrastructure.ts`). */
const TRIGGER_LABELS: Record<string, string> = {
  intent_change: 'Intent change',
  sweep: 'Sweep',
  manual: 'Manual',
  poll: 'Poll'
};

/**
 * `subjectId` becomes a `Link` only for the subject types with an existing
 * detail route (`domain` → `/infrastructure/domains/$name`, `hosting_target`
 * → `/infrastructure/fleet/$name`), keyed on the already-resolved
 * `subjectLabel` (the route param is a name, not the row id). `token`/
 * `proxy_resource`/`template_run` have no detail page today, so they keep
 * rendering as plain text rather than a fabricated link.
 */
export function SubjectCell({ run }: { run: ReconcileRunDto }) {
  const label = run.subjectLabel ?? run.subjectId;
  const suffix = <span className='text-muted-foreground'> ({run.subjectType})</span>;

  if (run.subjectType === 'domain' && run.subjectLabel) {
    return (
      <span>
        <Link
          to='/infrastructure/domains/$name'
          params={{ name: run.subjectLabel }}
          className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          {label}
        </Link>
        {suffix}
      </span>
    );
  }
  if (run.subjectType === 'hosting_target' && run.subjectLabel) {
    return (
      <span>
        <Link
          to='/infrastructure/fleet/$name'
          params={{ name: run.subjectLabel }}
          className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          {label}
        </Link>
        {suffix}
      </span>
    );
  }
  return (
    <span>
      {label}
      {suffix}
    </span>
  );
}

export function getColumns(): ColumnDef<DataTableFeatures, ReconcileRunDto>[] {
  return [
    {
      id: 'kind',
      accessorKey: 'kind',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Run' />
      ),
      cell: ({ row }) => (
        <Link
          to='/infrastructure/runs/$id'
          params={{ id: row.original.id }}
          className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          {row.original.kind}
        </Link>
      ),
      meta: {
        label: 'Run',
        placeholder: 'Search runs...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'subject',
      header: 'Subject',
      cell: ({ row }) => <SubjectCell run={row.original} />
    },
    {
      id: 'mode',
      accessorKey: 'mode',
      header: 'Mode',
      cell: ({ row }) => (
        <Badge variant='outline'>{RUN_MODE_LABELS[row.original.mode] ?? row.original.mode}</Badge>
      )
    },
    {
      id: 'trigger',
      accessorKey: 'trigger',
      enableSorting: false,
      header: 'Trigger',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-xs'>
          {TRIGGER_LABELS[row.original.trigger] ?? row.original.trigger}
        </span>
      )
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Status' />
      ),
      cell: ({ row }) => {
        const { status, errorSummary } = row.original;
        return (
          <div className='flex flex-col gap-0.5'>
            <ToneBadge tone={RUN_STATUS_TONE[status] ?? 'secondary'}>{status}</ToneBadge>
            {errorSummary && (
              <span className='text-destructive line-clamp-1 text-xs' title={errorSummary}>
                {errorSummary}
              </span>
            )}
          </div>
        );
      },
      enableColumnFilter: true,
      meta: { label: 'Status', variant: 'multiSelect' as const, options: STATUS_OPTIONS }
    },
    {
      id: 'stepCount',
      accessorKey: 'stepCount',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Steps' />
      ),
      cell: ({ row }) => (
        <span className='block text-right tabular-nums'>{row.original.stepCount}</span>
      )
    },
    {
      id: 'startedAt',
      accessorKey: 'startedAt',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Started' />
      ),
      cell: ({ row }) => <span>{formatDateTime(row.original.startedAt)}</span>
    },
    {
      id: 'finishedAt',
      accessorKey: 'finishedAt',
      header: ({ column }: { column: Column<DataTableFeatures, ReconcileRunDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Finished' />
      ),
      cell: ({ row }) => (
        <span className='text-muted-foreground'>{formatDateTime(row.original.finishedAt)}</span>
      )
    }
  ];
}
