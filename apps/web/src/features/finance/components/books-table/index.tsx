import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { booksQuery } from '@/features/finance/api/books-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { BookListItemDto } from '@/server/books-functions';
import { createColumns } from './columns';

/**
 * A small admin list — every book is fetched already (installations rarely
 * carry more than a handful), so this is client-side sort/filter/page only,
 * matching `/settings/entities`' shape rather than the offset-paginated
 * `/finance/expenses` table.
 */
export default function BooksTable() {
  const { data, isPending, isError, error, refetch } = useQuery(booksQuery);
  const columns = React.useMemo(() => createColumns(), []);

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  }

  if (isError) {
    return <QueryErrorAlert error={error} title='Could not load books' onRetry={() => refetch()} />;
  }

  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.ledger />
          </EmptyMedia>
          <EmptyTitle>No accounting books yet</EmptyTitle>
          <EmptyDescription>
            A book pairs a chart of accounts with a fiscal calendar. Create one to seed the starter
            chart and open its first fiscal year in a single step.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <BooksDataTable data={data} columns={columns} />;
}

function BooksDataTable({
  data,
  columns
}: {
  data: BookListItemDto[];
  columns: ReturnType<typeof createColumns>;
}) {
  const { table } = useDataTable({
    data,
    columns,
    pageCount: 1,
    getRowId: (book) => book.id,
    shallow: true,
    debounceMs: 500,
    initialState: { pagination: { pageIndex: 0, pageSize: 20 } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
