import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatMoney } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { InvoiceNinjaEstateInvoiceDto } from '@/server/invoiceninja-estate-functions';

/**
 * Invoice Ninja's own mapped status vocabulary (`INVOICENINJA_INVOICE_STATUS_MAP`
 * — the adapter's translation, not a Loxep-coined verdict; see
 * `invoiceninja-estate-functions.ts`'s own doc), rendered verbatim (Rule
 * P3). Only `paid` gets a positive tone; every other value renders through
 * the neutral `outline` tone.
 */
const STATUS_TONE: Record<string, 'success' | 'outline' | 'destructive'> = {
  paid: 'success',
  cancelled: 'destructive',
  reversed: 'destructive'
};

export function invoiceNinjaInvoiceColumns(
  onViewDetail: (invoice: InvoiceNinjaEstateInvoiceDto) => void,
  selectedInvoiceId: string | null
): ColumnDef<DataTableFeatures, InvoiceNinjaEstateInvoiceDto>[] {
  return [
    {
      id: 'number',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, InvoiceNinjaEstateInvoiceDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Invoice' />,
      cell: ({ row }) => (
        <span className='font-medium'>
          {row.original.number ?? (
            <span className='text-muted-foreground'>(draft — unnumbered)</span>
          )}
        </span>
      ),
      meta: { label: 'Invoice' }
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <ToneBadge tone={STATUS_TONE[row.original.status] ?? 'outline'}>
          {row.original.statusRecognized ? row.original.status : row.original.statusIdRaw}
        </ToneBadge>
      ),
      enableColumnFilter: true,
      meta: { label: 'Status', variant: 'multiSelect' as const }
    },
    {
      id: 'amount',
      header: 'Amount',
      cell: ({ row }) => <span>{formatMoney(row.original.amount, null)}</span>
    },
    {
      id: 'balance',
      header: 'Balance',
      cell: ({ row }) => <span>{formatMoney(row.original.balance, null)}</span>
    },
    {
      id: 'dueOn',
      header: 'Due',
      cell: ({ row }) =>
        row.original.dueOn === null ? (
          <span className='text-muted-foreground'>—</span>
        ) : (
          <span className='text-xs'>{row.original.dueOn}</span>
        )
    },
    {
      id: 'crossReference',
      header: 'Loxep record',
      cell: ({ row }) => {
        const reference = row.original.crossReference;
        if (reference.kind !== 'linked') {
          return <Badge variant='secondary'>No draft push recorded</Badge>;
        }
        return (
          <Button size='sm' variant='link' className='h-auto p-0' asChild>
            <Link to='/finance/overview'>
              <Icons.circleCheck className='mr-1 h-3.5 w-3.5' />
              {reference.counterpartyDisplayName ?? 'Draft pushed'}
              {reference.projectReferenceCode !== null && ` (${reference.projectReferenceCode})`}
            </Link>
          </Button>
        );
      }
    },
    {
      id: 'detail',
      header: 'Detail',
      cell: ({ row }) => {
        const isOpen = selectedInvoiceId === row.original.externalInvoiceId;
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
