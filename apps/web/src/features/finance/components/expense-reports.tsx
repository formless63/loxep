import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { Icons } from '@/components/icons';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatMoney } from '@/lib/format';
import type { MissingReceiptRowDto, UnallocatedExpenseRowDto } from '@/server/expense-functions';

const missingReceiptsColumns: ColumnDef<DataTableFeatures, MissingReceiptRowDto>[] = [
  {
    id: 'referenceCode',
    accessorKey: 'referenceCode',
    header: 'Reference',
    cell: ({ row }) => (
      <Link
        to='/finance/expenses/$id'
        params={{ id: row.original.expenseId }}
        className='font-medium hover:underline'
      >
        {row.original.referenceCode}
      </Link>
    )
  },
  {
    id: 'expenseDate',
    accessorKey: 'expenseDate',
    header: 'Date',
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>{formatDate(cell.getValue<string>())}</span>
    )
  },
  {
    id: 'category',
    accessorKey: 'category',
    header: 'Category'
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
    id: 'amount',
    accessorKey: 'amount',
    header: 'Amount',
    cell: ({ row }) => (
      <div className='text-right tabular-nums'>
        {formatMoney(row.original.amount, row.original.currency)}
      </div>
    )
  }
];

/** "Which of last quarter's expenses has none attached" — the report `ReceiptsService.missingReceipts` owes. */
export function MissingReceiptsList({ rows }: { rows: MissingReceiptRowDto[] }) {
  const table = useTable({
    data: rows,
    columns: missingReceiptsColumns,
    features: dataTableFeatures,
    manualPagination: true
  });

  if (rows.length === 0) {
    return (
      <Empty className='py-6'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.circleCheck />
          </EmptyMedia>
          <EmptyTitle>Every recorded expense has a receipt</EmptyTitle>
          <EmptyDescription>Nothing is missing paper right now.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <DataTable table={table} />;
}

const unallocatedColumns: ColumnDef<DataTableFeatures, UnallocatedExpenseRowDto>[] = [
  {
    id: 'referenceCode',
    accessorKey: 'referenceCode',
    header: 'Reference',
    cell: ({ row }) => (
      <Link
        to='/finance/expenses/$id'
        params={{ id: row.original.expenseId }}
        className='font-medium hover:underline'
      >
        {row.original.referenceCode}
      </Link>
    )
  },
  {
    id: 'expenseDate',
    accessorKey: 'expenseDate',
    header: 'Date',
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>{formatDate(cell.getValue<string>())}</span>
    )
  },
  {
    id: 'amount',
    accessorKey: 'amount',
    header: 'Amount',
    cell: ({ row }) => (
      <div className='text-right tabular-nums'>
        {formatMoney(row.original.amount, row.original.currency)}
      </div>
    )
  },
  {
    id: 'unallocatedAmount',
    accessorKey: 'unallocatedAmount',
    header: 'Unallocated',
    cell: ({ row }) => (
      <div className='text-right tabular-nums'>
        {formatMoney(row.original.unallocatedAmount, row.original.currency)}
      </div>
    )
  },
  {
    id: 'allocationCount',
    accessorKey: 'allocationCount',
    header: 'Splits',
    cell: ({ cell }) => <div className='text-right tabular-nums'>{cell.getValue<number>()}</div>
  }
];

/**
 * `sum(expense_allocations.amount) = expenses.amount` is a SERVICE rule and
 * a REPORT, never a trigger (`@loxep/accounting/expenses.ts`'s own doc) — an
 * under-allocated draft is legitimate. This is that report.
 */
export function UnallocatedExpensesList({ rows }: { rows: UnallocatedExpenseRowDto[] }) {
  const table = useTable({
    data: rows,
    columns: unallocatedColumns,
    features: dataTableFeatures,
    manualPagination: true
  });

  if (rows.length === 0) {
    return (
      <Empty className='py-6'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.circleCheck />
          </EmptyMedia>
          <EmptyTitle>Nothing unallocated</EmptyTitle>
          <EmptyDescription>
            Every non-void expense is fully split (or has no split at all).
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <DataTable table={table} />;
}
