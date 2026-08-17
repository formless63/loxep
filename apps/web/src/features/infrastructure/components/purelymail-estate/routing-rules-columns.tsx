import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import type { PurelymailEstateRoutingRuleDto } from '@/server/purelymail-estate-functions';

export const purelymailRoutingRuleColumns: ColumnDef<
  DataTableFeatures,
  PurelymailEstateRoutingRuleDto
>[] = [
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
  }
];
