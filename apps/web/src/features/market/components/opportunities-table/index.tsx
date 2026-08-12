import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
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
import { parseSortingState } from '@/lib/parsers';
import { opportunityEventsQuery } from '@/features/market/api/queries';
import { applyClientSort, isSameLocalDay } from '@/features/market/lib/apply-client-sort';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { OpportunityEventDto, OpportunityEventsPageDto } from '@/server/market-functions';
import { columns } from './columns';

const columnIds = columns.map((c) => c.id).filter(Boolean) as string[];

/**
 * Recent rule-stamped events (`market_events` where `rule_id IS NOT NULL`) —
 * loxep-7dp.6's opportunities dashboard, reading `fetchOpportunityEvents`
 * (`@/server/market-functions`). Score comes from `payload.opportunity`,
 * the block `stampEventWithRule` (`@loxep/market/opportunities.ts`) writes.
 */
export default function OpportunitiesTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const serverPage = Math.max(0, page - 1);

  const { data, isPending, isError, error, refetch } = useQuery(opportunityEventsQuery(serverPage));

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={1} />;
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load opportunities'
        onRetry={() => refetch()}
      />
    );
  }

  if (data.total === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.sparkles />
          </EmptyMedia>
          <EmptyTitle>No opportunities yet</EmptyTitle>
          <EmptyDescription>
            An event is stamped with a rule (and scored) when it matches an enabled opportunity
            rule&apos;s conditions. Nothing has matched yet.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <OpportunitiesDataTable data={data} />;
}

function OpportunitiesDataTable({ data }: { data: OpportunityEventsPageDto }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const sortStr = search.sort as string | undefined;
  const detectedAtParam = search.detectedAt as string | undefined;

  const sorting = parseSortingState<OpportunityEventDto>(sortStr, columnIds);

  const selectedDate = detectedAtParam ? new Date(Number(detectedAtParam)) : null;
  const filtered =
    selectedDate === null
      ? data.events
      : data.events.filter((event) => isSameLocalDay(new Date(event.detectedAt), selectedDate));

  const sorted = applyClientSort(filtered, sorting, {
    rule: (row) => row.ruleName,
    score: (row) => row.score,
    detectedAt: (row) => row.detectedAt
  });

  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  const { table } = useDataTable({
    data: sorted,
    columns,
    pageCount,
    shallow: true,
    debounceMs: 500,
    initialState: { pagination: { pageIndex: 0, pageSize: data.pageSize } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
