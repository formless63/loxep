import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import type { ProvisioningTemplateDto } from '@/server/provisioning-functions';

export function getColumns(): ColumnDef<DataTableFeatures, ProvisioningTemplateDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, ProvisioningTemplateDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Name' />,
      cell: ({ row }) => (
        <div className='flex items-center gap-2'>
          <Link
            to='/infrastructure/templates/$id'
            params={{ id: row.original.id }}
            className='font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
          >
            {row.original.name}
          </Link>
          {row.original.isDefault && <Badge variant='secondary'>Default</Badge>}
        </div>
      ),
      meta: {
        label: 'Name',
        placeholder: 'Search templates...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'description',
      header: 'Description',
      cell: ({ row }) =>
        row.original.description ? (
          <span className='text-muted-foreground line-clamp-1'>{row.original.description}</span>
        ) : (
          <span className='text-muted-foreground'>—</span>
        )
    },
    {
      id: 'version',
      header: 'Version',
      cell: ({ row }) => <span className='font-mono text-xs'>v{row.original.version}</span>
    },
    {
      id: 'steps',
      header: 'Steps',
      cell: ({ row }) => <span>{row.original.stepCount}</span>
    },
    {
      id: 'runs',
      header: 'Runs',
      cell: ({ row }) => <span>{row.original.runCount}</span>
    }
  ];
}
