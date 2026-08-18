import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { countByKey, sumMoneyBy } from '@/lib/aggregate';
import { formatMoney } from '@/lib/format';
import { parseSortingState } from '@/lib/parsers';
import { expensesQuery, type ExpenseFilterParams } from '@/features/finance/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { EntityDto } from '@/server/admin-functions';
import type { ExpenseListItemDto } from '@/server/expense-functions';
import type { ExpenseStatus } from '@/features/finance/constants';
import { UNATTRIBUTED_ENTITY_VALUE } from '@/features/finance/constants';
import { sortRows } from '@/features/market/lib/sort-rows';
import { createColumns } from './columns';

const COLUMN_IDS = [
  'expenseDate',
  'referenceCode',
  'payeeName',
  'category',
  'economicEntityId',
  'amount',
  'paymentMethod',
  'status',
  'receiptCount'
];

const DEFAULT_PAGE_SIZE = 10;

/**
 * `fetchExpenses` (`@loxep/accounting/reports.ts` `listExpenses`) has no
 * offset/cursor, only a `limit` — this table mirrors `/market/monitors`'
 * shape: the server does the filtering the service actually supports
 * (entity/date/category/status), the table sorts/pages the (bounded) result
 * client-side.
 */
export default function ExpensesTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate() as (opts: {
    search: (prev: Record<string, unknown>) => Record<string, unknown>;
    replace?: boolean;
  }) => Promise<void>;

  const category = search.category as string | undefined;
  const economicEntityIdParam = search.economicEntityId as string | undefined;
  const statusParam = search.status as string | undefined;
  const from = search.from as string | undefined;
  const to = search.to as string | undefined;
  const q = search.q as string | undefined;

  const filter: ExpenseFilterParams = {
    ...(category ? { category } : {}),
    ...(economicEntityIdParam
      ? {
          economicEntityId:
            economicEntityIdParam === UNATTRIBUTED_ENTITY_VALUE ? null : economicEntityIdParam
        }
      : {}),
    ...(statusParam ? { statuses: statusParam.split(',') as ExpenseStatus[] } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(q ? { q } : {})
  };

  const { data: entities } = useQuery(entitiesQuery);
  const { data, isPending, isError, error, refetch } = useQuery(expensesQuery(filter));

  if (isPending || entities === undefined) {
    return <DataTableSkeleton columnCount={9} filterCount={3} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load expenses' onRetry={() => refetch()} />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-end gap-4'>
        <div className='grid gap-1.5'>
          <Label htmlFor='expenses-from'>From</Label>
          <Input
            id='expenses-from'
            type='date'
            value={from ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              void navigate({
                search: (prev) => ({ ...prev, page: 1, from: value === '' ? undefined : value }),
                replace: true
              });
            }}
          />
        </div>
        <div className='grid gap-1.5'>
          <Label htmlFor='expenses-to'>To</Label>
          <Input
            id='expenses-to'
            type='date'
            value={to ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              void navigate({
                search: (prev) => ({ ...prev, page: 1, to: value === '' ? undefined : value }),
                replace: true
              });
            }}
          />
        </div>
        {(from || to) && (
          <Button
            variant='outline'
            size='sm'
            onClick={() =>
              void navigate({
                search: (prev) => ({ ...prev, page: 1, from: undefined, to: undefined }),
                replace: true
              })
            }
          >
            Clear dates
          </Button>
        )}
        <div className='grid gap-1.5'>
          <Label htmlFor='expenses-q'>Search receipt text</Label>
          <div className='relative w-64'>
            <Icons.search
              className='text-muted-foreground/70 pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2'
              aria-hidden='true'
            />
            <Input
              id='expenses-q'
              type='search'
              value={q ?? ''}
              placeholder='e.g. a brand, model, or store name'
              className='pl-9'
              onChange={(event) => {
                const value = event.target.value;
                void navigate({
                  search: (prev) => ({ ...prev, page: 1, q: value === '' ? undefined : value }),
                  replace: true
                });
              }}
            />
          </div>
        </div>
      </div>
      {q ? (
        <p className='text-muted-foreground text-xs'>
          Searching extracted receipt/invoice text — distinct from the payee/category filters above.
          Only expenses whose ATTACHED RECEIPT text matches appear; an expense recorded with no
          receipt, or one whose receipt predates text extraction being enabled, will not match even
          if the phrase describes the purchase.
        </p>
      ) : null}

      {data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant='icon'>{q ? <Icons.search /> : <Icons.fees />}</EmptyMedia>
            <EmptyTitle>{q ? `No matches for "${q}"` : 'No expenses'}</EmptyTitle>
            <EmptyDescription>
              {q
                ? 'No expense has an attached receipt with extracted text matching that search.'
                : 'Every dollar that leaves gets captured here — card, cash, marketplace balance, or anything else.'}
            </EmptyDescription>
          </EmptyHeader>
          {!q && (
            <EmptyContent>
              <Button size='sm' asChild>
                <Link to='/finance/expenses/new'>
                  <Icons.add />
                  New expense
                </Link>
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <ExpensesDataTable expenses={data} entities={entities} q={q} />
      )}
    </div>
  );
}

function ExpensesDataTable({
  expenses,
  entities,
  q
}: {
  expenses: ExpenseListItemDto[];
  entities: EntityDto[];
  q?: string;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const columns = React.useMemo(() => createColumns(entities, q), [entities, q]);

  const sorting = parseSortingState<ExpenseListItemDto>(sortStr, COLUMN_IDS);
  const sorted = sortRows(expenses, sorting, {
    expenseDate: (row) => row.expenseDate,
    referenceCode: (row) => row.referenceCode,
    amount: (row) => Number(row.amount)
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns,
    pageCount,
    getRowId: (expense) => expense.id,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE }
    }
  });

  // Totals are computed over the FULL filtered result (`expenses`), not
  // `pageRows` — a per-currency total that silently reflected only the
  // current page would be misleading the moment there is a second page
  // (Frontend Standards' "honest over the full dataset" rule for the
  // unbounded-fetch exception this table already relies on for sort/filter).
  const amountByCurrency = sumMoneyBy(
    expenses,
    (expense) => expense.amount,
    (expense) => expense.currency
  );
  const taxByCurrency = sumMoneyBy(
    expenses,
    (expense) => expense.taxAmount,
    (expense) => expense.currency
  );
  const countsByCurrency = countByKey(expenses, (expense) => expense.currency);

  return (
    <DataTable
      table={table}
      summary={
        <>
          {[...countsByCurrency.entries()].map(([currency, count]) => (
            <TableRow key={currency}>
              <TableCell colSpan={5} className='font-medium'>
                Total — {count} expense{count === 1 ? '' : 's'} ({currency})
              </TableCell>
              <TableCell className='text-right font-medium tabular-nums'>
                <div className='flex flex-col items-end'>
                  <span>{formatMoney(amountByCurrency.get(currency), currency)}</span>
                  <span className='text-muted-foreground text-xs font-normal'>
                    + {formatMoney(taxByCurrency.get(currency), currency)} tax
                  </span>
                </div>
              </TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          ))}
        </>
      }
    >
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
