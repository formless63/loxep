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
import { useDataTable } from '@/hooks/use-data-table';
import { Icons } from '@/components/icons';
import { postingRulesQuery } from '@/features/finance/api/posting-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { PostingRuleListItemDto } from '@/server/posting-functions';
import { getColumns } from './columns';
import RuleDetailDialog from './rule-detail-dialog';

/**
 * Read-only posting-rule list (loxep-6ea, audit finding A3) —
 * `PostingRulesService`'s read verbs, mounted for the first time. Rule
 * authoring is out of scope; there is no create/edit affordance here.
 */
export default function PostingRulesTable() {
  const { data, isPending, isError, error, refetch } = useQuery(postingRulesQuery);
  const [viewing, setViewing] = React.useState<PostingRuleListItemDto | null>(null);

  const columns = React.useMemo(() => getColumns(setViewing), []);

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={2} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load posting rules'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.ledger />
          </EmptyMedia>
          <EmptyTitle>No posting rules yet</EmptyTitle>
          <EmptyDescription>
            The posting engine seeds its default rule set on its next sweep.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <RulesDataTable rows={data} columns={columns} />
      <RuleDetailDialog rule={viewing} onOpenChange={(open) => !open && setViewing(null)} />
    </>
  );
}

function RulesDataTable({
  rows,
  columns
}: {
  rows: PostingRuleListItemDto[];
  columns: ReturnType<typeof getColumns>;
}) {
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount: 1,
    getRowId: (rule) => rule.id,
    shallow: true,
    initialState: { columnPinning: { start: [], end: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
