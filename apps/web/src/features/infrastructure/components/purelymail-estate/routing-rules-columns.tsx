import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import type { PurelymailEstateRoutingRuleDto } from '@/server/purelymail-estate-functions';
import { PurelymailRoutingRuleRowActions } from './routing-rule-row-actions';

/**
 * `connectionId` is a factory parameter (matching `purelymailDomainColumns`'s
 * own precedent) — the row-action cell needs it to mount
 * `MailboxAdminService.deleteRoutingRule` (loxep-47o.11).
 */
export function purelymailRoutingRuleColumns(
  connectionId: string
): ColumnDef<DataTableFeatures, PurelymailEstateRoutingRuleDto>[] {
  return [
    {
      id: 'matchUser',
      accessorKey: 'matchUser',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, PurelymailEstateRoutingRuleDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Match' />,
      cell: ({ row }) => (
        <span className='font-mono text-sm'>
          {row.original.matchUser || '(empty)'}@{row.original.domainName}
          {row.original.prefix && (
            <Badge variant='outline' className='ml-2'>
              prefix
            </Badge>
          )}
          {row.original.catchall && (
            <Badge variant='outline' className='ml-2'>
              catch-all
            </Badge>
          )}
        </span>
      ),
      meta: {
        label: 'Match',
        placeholder: 'Search routing rules...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'targetAddresses',
      header: 'Forwards to',
      cell: ({ row }) => (
        <span className='font-mono text-sm'>{row.original.targetAddresses.join(', ') || '—'}</span>
      )
    },
    {
      id: 'loxep',
      header: 'In Loxep',
      cell: ({ row }) =>
        row.original.loxep === null ? (
          <Badge variant='secondary'>no Loxep mailbox row</Badge>
        ) : (
          <Badge variant='outline'>
            <Icons.circleCheck className='mr-1 h-3 w-3' />
            declared
          </Badge>
        )
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        // Gated on a Loxep intent row, matching `purelymailMailboxColumns`'s own
        // precedent — the reconcile run this writes needs a
        // `managed_domains.id` subject.
        row.original.loxep !== null ? (
          <PurelymailRoutingRuleRowActions
            connectionId={connectionId}
            domainId={row.original.loxep.managedDomainId}
            routingRuleId={row.original.id}
            matchUser={row.original.matchUser}
            domainName={row.original.domainName}
          />
        ) : null
    }
  ];
}
