import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatMoney, formatQuantity } from '@/lib/format';
import {
  completeItemIntakeReview,
  type InventoryItemListItemDto
} from '@/server/inventory-functions';
import {
  itemConditionLabel,
  itemConditionOptions,
  itemStatusLabel,
  itemStatusOptions,
  itemStatusTone
} from '@/features/inventory/constants';

/**
 * "Complete review" — the intake review screen's one row action, per
 * loxep-dgf.2's follow-up: there was no exit from `intake` anywhere until
 * now. Only rendered for `intake`-status rows; every other row cell is
 * blank rather than a disabled button, matching `monitors-table`'s
 * admin-gating precedent of omitting rather than disabling.
 */
function CompleteReviewCell({ item }: { item: InventoryItemListItemDto }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => completeItemIntakeReview({ data: { id: item.id } }),
    onSuccess: () => {
      toast.success(`${item.itemCode} marked available`);
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => toastError(error, 'Could not complete review')
  });

  if (item.status !== 'intake') return null;

  return (
    <Button
      size='sm'
      variant='outline'
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      <Icons.check />
      Complete review
    </Button>
  );
}

export function createColumns(
  locationOptions: { value: string; label: string }[]
): ColumnDef<DataTableFeatures, InventoryItemListItemDto>[] {
  return [
    {
      id: 'itemCode',
      accessorKey: 'itemCode',
      header: 'Item',
      cell: ({ row }) => (
        <Link
          to='/inventory/stock/$id'
          params={{ id: row.original.id }}
          className='font-medium hover:underline'
        >
          {row.original.itemCode}
        </Link>
      )
    },
    {
      id: 'label',
      accessorKey: 'label',
      enableSorting: false,
      header: 'Description',
      cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>,
      enableColumnFilter: true,
      meta: {
        label: 'Description',
        placeholder: 'Search description…',
        variant: 'text' as const,
        icon: Icons.text
      }
    },
    {
      id: 'status',
      accessorKey: 'status',
      enableSorting: false,
      header: 'Status',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return <Badge variant={itemStatusTone(status)}>{itemStatusLabel(status)}</Badge>;
      },
      enableColumnFilter: true,
      meta: {
        label: 'Status',
        variant: 'select' as const,
        options: itemStatusOptions
      }
    },
    {
      id: 'conditionCode',
      accessorKey: 'conditionCode',
      enableSorting: false,
      header: 'Condition',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{itemConditionLabel(cell.getValue<string>())}</span>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Condition',
        variant: 'select' as const,
        options: itemConditionOptions
      }
    },
    {
      id: 'locationId',
      accessorKey: 'locationId',
      enableSorting: false,
      header: 'Location',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>{row.original.locationCode ?? '—'}</span>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Location',
        variant: 'select' as const,
        options: locationOptions
      }
    },
    {
      id: 'quantityOnHand',
      accessorKey: 'quantityOnHand',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, InventoryItemListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='On hand' />,
      cell: ({ row }) => (
        <div className='text-right tabular-nums'>
          {formatQuantity(Number(row.original.quantityOnHand))}
          <span className='text-muted-foreground'>
            {' '}
            / {formatQuantity(Number(row.original.quantity))}
          </span>
        </div>
      )
    },
    {
      id: 'landedCostAmount',
      accessorKey: 'landedCostAmount',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, InventoryItemListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Landed cost' />,
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.landedCostAmount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'acquisitionReferenceCode',
      accessorKey: 'acquisitionReferenceCode',
      enableSorting: false,
      header: 'Lot',
      cell: ({ row }) =>
        row.original.acquisitionId ? (
          <Link
            to='/inventory/acquisitions/$id'
            params={{ id: row.original.acquisitionId }}
            className='text-muted-foreground hover:underline'
          >
            {row.original.acquisitionReferenceCode}
          </Link>
        ) : (
          <span className='text-muted-foreground'>—</span>
        )
    },
    {
      id: 'acquiredAt',
      accessorKey: 'acquiredAt',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, InventoryItemListItemDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Acquired' />,
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDate(cell.getValue<string>())}
        </span>
      )
    },
    {
      id: 'actions',
      enableSorting: false,
      header: '',
      cell: ({ row }) => <CompleteReviewCell item={row.original} />
    }
  ];
}
