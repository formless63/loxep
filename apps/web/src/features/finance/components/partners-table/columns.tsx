import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate } from '@/lib/format';
import type { PartnerListItemDto } from '@/server/partners-functions';
import {
  partnerKindLabel,
  partnerKindOptions,
  partnerRoleLabel,
  partnerRoleOptions,
  partnerStatusLabel,
  partnerStatusOptions,
  partnerStatusTone
} from '@/features/finance/constants';
import { CellAction } from './cell-action';

function ContactCell({ contact }: { contact: PartnerListItemDto['primaryContact'] }) {
  if (contact === null) {
    return <span className='text-muted-foreground'>—</span>;
  }
  return (
    <div className='flex flex-col'>
      <span>{contact.name}</span>
      {contact.email && <span className='text-muted-foreground text-xs'>{contact.email}</span>}
    </div>
  );
}

/** Quiet check/dash, not a data column of its own weight — the Invoice Ninja push flow lives on the expense detail page, not here. */
function BillingLinkCell({ linked }: { linked: boolean }) {
  if (!linked) {
    return <span className='text-muted-foreground'>—</span>;
  }
  return (
    <span
      className='text-muted-foreground flex items-center gap-1'
      title='Linked to an Invoice Ninja client'
    >
      <Icons.check className='text-success h-4 w-4' />
    </span>
  );
}

export function createColumns(): ColumnDef<DataTableFeatures, PartnerListItemDto>[] {
  return [
    {
      id: 'displayName',
      accessorKey: 'displayName',
      header: ({ column }: { column: Column<DataTableFeatures, PartnerListItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Name' />
      ),
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span className='font-medium'>{row.original.displayName}</span>
          {row.original.legalName && (
            <span className='text-muted-foreground text-xs'>{row.original.legalName}</span>
          )}
        </div>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Name',
        placeholder: 'Search trading partners…',
        variant: 'text' as const,
        icon: Icons.text
      }
    },
    {
      id: 'kind',
      accessorKey: 'kind',
      header: 'Kind',
      cell: ({ cell }) => (
        <Badge variant='outline'>{partnerKindLabel(cell.getValue<string>())}</Badge>
      ),
      enableColumnFilter: true,
      meta: { label: 'Kind', variant: 'select' as const, options: partnerKindOptions }
    },
    {
      id: 'referenceCode',
      accessorKey: 'referenceCode',
      header: 'Reference',
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>{cell.getValue<string>()}</span>
      )
    },
    {
      id: 'roles',
      accessorFn: (row) => row.roles.join(','),
      header: 'Roles',
      enableSorting: false,
      cell: ({ row }) => {
        if (row.original.roles.length === 0) {
          return <span className='text-muted-foreground'>—</span>;
        }
        return (
          <div className='flex flex-wrap gap-1'>
            {row.original.roles.map((role) => (
              <Badge key={role} variant='outline'>
                {partnerRoleLabel(role)}
              </Badge>
            ))}
          </div>
        );
      },
      enableColumnFilter: true,
      meta: {
        label: 'Role',
        variant: 'multiSelect' as const,
        options: partnerRoleOptions
      },
      filterFn: (row, _id, filterValue) => {
        const values = filterValue as string[];
        if (!values || values.length === 0) return true;
        return row.original.roles.some((role) => values.includes(role));
      }
    },
    {
      id: 'primaryContact',
      header: 'Contact',
      enableSorting: false,
      cell: ({ row }) => <ContactCell contact={row.original.primaryContact} />
    },
    {
      id: 'hasBillingClientLink',
      header: 'Invoice Ninja',
      enableSorting: false,
      cell: ({ row }) => <BillingLinkCell linked={row.original.hasBillingClientLink} />
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: 'Status',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return <Badge variant={partnerStatusTone(status)}>{partnerStatusLabel(status)}</Badge>;
      },
      enableColumnFilter: true,
      meta: { label: 'Status', variant: 'multiSelect' as const, options: partnerStatusOptions }
    },
    {
      id: 'createdAt',
      accessorKey: 'createdAt',
      header: ({ column }: { column: Column<DataTableFeatures, PartnerListItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Created' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDate(cell.getValue<string>())}
        </span>
      )
    },
    {
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} />
    }
  ];
}
