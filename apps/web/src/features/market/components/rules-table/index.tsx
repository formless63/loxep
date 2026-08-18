import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
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
import { parseSortingState } from '@/lib/parsers';
import { opportunityRulesQuery } from '@/features/market/api/queries';
import { sortRows } from '@/features/market/lib/sort-rows';
import RuleFormDialog from '@/features/market/components/rule-form-dialog';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { OpportunityRuleDto } from '@/server/market-functions';
import { createColumns } from './columns';

const COLUMN_IDS = ['name', 'enabled', 'priority', 'scoreWeight', 'conditions', 'updatedAt'];
const DEFAULT_PAGE_SIZE = 10;

/**
 * `createOpportunityRulesService` (loxep-7fs, A16) had zero consumers —
 * `/market/opportunities` renders scored events from rules nobody could
 * author, edit, prioritize, or delete. Structurally identical to
 * `monitors-table`: `fetchOpportunityRules` returns every rule unbounded, so
 * this table paginates, sorts, and filters the full set client-side.
 */
export default function RulesTable({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(opportunityRulesQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<OpportunityRuleDto | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (rule: OpportunityRuleDto) => {
    setEditing(rule);
    setDialogOpen(true);
  };

  if (isPending) {
    return <DataTableSkeleton columnCount={isAdmin ? 7 : 6} filterCount={0} />;
  }

  if (isError) {
    return <QueryErrorAlert error={error} title='Could not load rules' onRetry={() => refetch()} />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={openCreate}>
            <Icons.add />
            New rule
          </Button>
        </div>
      )}

      {data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.sparkles />
            </EmptyMedia>
            <EmptyTitle>No opportunity rules</EmptyTitle>
            <EmptyDescription>
              Without a rule, no derived market event is ever scored — the opportunity vertical
              stays inert. Create one to start scoring events.
            </EmptyDescription>
          </EmptyHeader>
          {isAdmin && (
            <EmptyContent>
              <Button size='sm' onClick={openCreate}>
                <Icons.add />
                New rule
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <RulesDataTable rules={data} isAdmin={isAdmin} onEdit={openEdit} />
      )}

      {dialogOpen && (
        <RuleFormDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          rule={editing}
        />
      )}
    </div>
  );
}

function RulesDataTable({
  rules,
  isAdmin,
  onEdit
}: {
  rules: OpportunityRuleDto[];
  isAdmin: boolean;
  onEdit: (rule: OpportunityRuleDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const columns = React.useMemo(() => createColumns(onEdit, isAdmin), [onEdit, isAdmin]);

  const sorting = parseSortingState<OpportunityRuleDto>(sortStr, COLUMN_IDS);
  const sorted = sortRows(rules, sorting, {
    name: (row) => row.name,
    priority: (row) => row.priority,
    updatedAt: (row) => row.updatedAt
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns,
    pageCount,
    getRowId: (rule) => rule.id,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE },
      columnPinning: isAdmin ? { start: [], end: ['actions'] } : undefined
    }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
