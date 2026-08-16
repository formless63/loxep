import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatMoney, formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { InvoiceNinjaEstateClientDto } from '@/server/invoiceninja-estate-functions';

/**
 * The Invoice Ninja estate's Clients columns (Estate Browsers Design §3.9).
 * `balance`/`paidToDate` render via `formatMoney` — display-only formatting
 * of the adapter's own decimal STRING, never JS arithmetic on the amount
 * (see `invoiceninja-estate-functions.ts`'s own "Money" doc). `currency` is
 * `null`: Invoice Ninja's client `currency_id` is a provider-internal
 * numeric id, not an ISO-4217 code this app can resolve on the read side
 * (see `clients.ts`'s own module doc) — `formatMoney` renders a plain
 * decimal rather than fabricate a currency symbol.
 */
export function invoiceNinjaClientColumns(
  onViewDetail: (client: InvoiceNinjaEstateClientDto) => void,
  selectedClientId: string | null
): ColumnDef<DataTableFeatures, InvoiceNinjaEstateClientDto>[] {
  return [
    {
      id: 'displayName',
      accessorKey: 'displayName',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, InvoiceNinjaEstateClientDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Client' />,
      cell: ({ row }) => (
        <div className='flex flex-col'>
          <span className='font-medium'>{row.original.displayName || row.original.name}</span>
          {row.original.number !== null && (
            <span className='text-muted-foreground text-xs'>{row.original.number}</span>
          )}
        </div>
      ),
      meta: {
        label: 'Client',
        placeholder: 'Search clients...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'balance',
      header: 'Balance',
      cell: ({ row }) => <span>{formatMoney(row.original.balance, null)}</span>
    },
    {
      id: 'paidToDate',
      header: 'Paid to date',
      cell: ({ row }) => <span>{formatMoney(row.original.paidToDate, null)}</span>
    },
    {
      id: 'updatedAt',
      header: 'Updated',
      cell: ({ row }) =>
        row.original.updatedAt === null ? (
          <span className='text-muted-foreground'>—</span>
        ) : (
          <span className='text-muted-foreground text-xs'>
            {formatRelativeTime(row.original.updatedAt)}
          </span>
        )
    },
    {
      id: 'crossReference',
      header: 'Loxep record',
      cell: ({ row }) => {
        const reference = row.original.crossReference;
        if (reference.kind !== 'linked') {
          return <Badge variant='secondary'>No linked counterparty</Badge>;
        }
        return (
          <span className='flex items-center gap-1.5 text-sm'>
            <Icons.circleCheck className='text-muted-foreground h-3.5 w-3.5' />
            {reference.counterpartyDisplayName}
            <span className='text-muted-foreground text-xs'>
              ({reference.counterpartyReferenceCode})
            </span>
          </span>
        );
      }
    },
    {
      id: 'detail',
      header: 'Detail',
      cell: ({ row }) => {
        const isOpen = selectedClientId === row.original.externalClientId;
        return (
          <Button
            size='sm'
            variant={isOpen ? 'default' : 'outline'}
            onClick={() => onViewDetail(row.original)}
          >
            {isOpen ? 'Hide detail' : 'View detail'}
          </Button>
        );
      }
    }
  ];
}
