import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatMoney } from '@/lib/format';
import type { EntityDto } from '@/server/admin-functions';
import type { ExpenseListItemDto } from '@/server/expense-functions';
import {
  expenseStatusLabel,
  expenseStatusTone,
  paymentMethodLabel,
  expenseStatusOptions,
  UNATTRIBUTED_ENTITY_VALUE
} from '@/features/finance/constants';

/** `entity_attribution_source` badge — a snapshot resolved once at creation, never a read-time join. */
function EntityCell({
  economicEntityId,
  entityAttributionSource,
  entitiesById
}: {
  economicEntityId: string | null;
  entityAttributionSource: string;
  entitiesById: Map<string, string>;
}) {
  if (economicEntityId === null) {
    return <span className='text-muted-foreground'>Unattributed</span>;
  }
  const name = entitiesById.get(economicEntityId) ?? economicEntityId;
  return (
    <span>
      {name}
      {entityAttributionSource === 'installation_default' && (
        <span className='text-muted-foreground ml-1 text-xs'>(default)</span>
      )}
    </span>
  );
}

function ReceiptCell({ count }: { count: number }) {
  if (count === 0) {
    return (
      <Badge variant='outline'>
        <Icons.fees />
        none
      </Badge>
    );
  }
  return (
    <Badge variant='secondary'>
      <Icons.fees />
      {count}
    </Badge>
  );
}

export function createColumns(
  entities: EntityDto[]
): ColumnDef<DataTableFeatures, ExpenseListItemDto>[] {
  const entitiesById = new Map(entities.map((entity) => [entity.id, entity.name]));
  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...entities.map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  return [
    {
      id: 'expenseDate',
      accessorKey: 'expenseDate',
      header: ({ column }: { column: Column<DataTableFeatures, ExpenseListItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Date' />
      ),
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>
          {formatDate(cell.getValue<string>())}
        </span>
      )
    },
    {
      id: 'referenceCode',
      accessorKey: 'referenceCode',
      header: 'Reference',
      cell: ({ row }) => (
        <Link
          to='/finance/expenses/$id'
          params={{ id: row.original.id }}
          className='font-medium hover:underline'
        >
          {row.original.referenceCode}
        </Link>
      )
    },
    {
      id: 'payeeName',
      accessorKey: 'payeeName',
      header: 'Payee',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{cell.getValue<string | null>() ?? '—'}</span>
      )
    },
    {
      id: 'category',
      accessorKey: 'category',
      header: 'Category',
      cell: ({ cell }) => <Badge variant='outline'>{cell.getValue<string>()}</Badge>,
      enableColumnFilter: true,
      meta: {
        label: 'Category',
        placeholder: 'Search category…',
        variant: 'text' as const,
        icon: Icons.text
      }
    },
    {
      id: 'economicEntityId',
      accessorKey: 'economicEntityId',
      enableSorting: false,
      header: 'Entity',
      cell: ({ row }) => (
        <EntityCell
          economicEntityId={row.original.economicEntityId}
          entityAttributionSource={row.original.entityAttributionSource}
          entitiesById={entitiesById}
        />
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Entity',
        variant: 'select' as const,
        options: entityOptions
      }
    },
    {
      id: 'amount',
      accessorKey: 'amount',
      header: ({ column }: { column: Column<DataTableFeatures, ExpenseListItemDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Amount' />
      ),
      cell: ({ row }) => (
        <div className='text-right font-medium tabular-nums'>
          {formatMoney(row.original.amount, row.original.currency)}
        </div>
      )
    },
    {
      id: 'paymentMethod',
      accessorKey: 'paymentMethod',
      enableSorting: false,
      header: 'Payment',
      cell: ({ cell }) => (
        <span className='text-muted-foreground'>{paymentMethodLabel(cell.getValue<string>())}</span>
      )
    },
    {
      id: 'status',
      accessorKey: 'status',
      enableSorting: false,
      header: 'Status',
      cell: ({ cell }) => {
        const status = cell.getValue<string>();
        return (
          <Badge variant={expenseStatusTone(status)}>
            {status === 'recorded' && <Icons.lock />}
            {expenseStatusLabel(status)}
          </Badge>
        );
      },
      enableColumnFilter: true,
      meta: {
        label: 'Status',
        variant: 'multiSelect' as const,
        options: expenseStatusOptions
      }
    },
    {
      id: 'receiptCount',
      accessorKey: 'receiptCount',
      enableSorting: false,
      header: 'Receipts',
      cell: ({ cell }) => (
        <div className='flex justify-end'>
          <ReceiptCell count={cell.getValue<number>()} />
        </div>
      )
    }
  ];
}
