import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import type { PurelymailEstateMailboxDto } from '@/server/purelymail-estate-functions';

export const purelymailMailboxColumns: ColumnDef<DataTableFeatures, PurelymailEstateMailboxDto>[] =
  [
    {
      id: 'address',
      accessorKey: 'address',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, PurelymailEstateMailboxDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Address' />,
      cell: ({ row }) => <span className='font-mono text-sm'>{row.original.address}</span>,
      meta: {
        label: 'Address',
        placeholder: 'Search mailboxes...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'loxep',
      header: 'Loxep',
      cell: ({ row }) =>
        row.original.loxep === null ? (
          // The unique fact this section adds (design §3.2): a mailbox that
          // exists in the account but corresponds to no `mailboxes` row —
          // invisible outside this page.
          <Badge variant='secondary'>no Loxep mailbox row</Badge>
        ) : (
          <Badge variant='outline'>
            <Icons.circleCheck className='mr-1 h-3 w-3' />
            {row.original.loxep.kind}
          </Badge>
        )
    }
  ];
