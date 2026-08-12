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
import {
  opportunityEventsQuery,
  type OpportunityEventsQueryParams
} from '@/features/market/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { OpportunityEventsPageDto } from '@/server/market-functions';
import { columns } from './columns';

const columnIds = columns.map((c) => c.id).filter(Boolean) as string[];

type OpportunitySortKey = 'rule' | 'score' | 'detectedAt';

function isOpportunitySortKey(id: string): id is OpportunitySortKey {
  return id === 'rule' || id === 'score' || id === 'detectedAt';
}

/**
 * The `detectedAt` toolbar filter is a single-day picker (`meta.variant:
 * 'date'`, not `'dateRange'` — see `columns.tsx`), stored in the URL as one
 * epoch-ms instant at local midnight of the picked day
 * (`DataTableDateFilter`'s `column.setFilterValue(date.getTime())`). Expand
 * it into the half-open `[dayStart, dayEnd)` range `fetchOpportunityEvents`
 * filters on, using the SAME Date's own year/month/day components (not a
 * flat +24h) so DST transitions never shift the boundary onto the wrong day.
 */
function localDayRange(date: Date): { from: Date; to: Date } {
  const from = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const to = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return { from, to };
}

/**
 * Reads the URL's `sort`/`detectedAt` state into `fetchOpportunityEvents`'
 * params. Column ids are UI-level identifiers, not all of them literal
 * `OpportunityEventDto` keys (`rule` is accessor-derived from `ruleName`),
 * so this parses against a loose `id: string` shape rather than
 * `ExtendedColumnSort<OpportunityEventDto>` — the `columnIds` whitelist
 * still enforces which ids are accepted.
 */
function opportunitySortAndFilterParams(
  search: Record<string, unknown>
): Omit<OpportunityEventsQueryParams, 'page'> {
  const [sort] = parseSortingState<Record<string, unknown>>(
    search.sort as string | undefined,
    columnIds
  );
  const sortParams =
    sort !== undefined && isOpportunitySortKey(sort.id)
      ? { sortBy: sort.id, sortDir: sort.desc ? ('desc' as const) : ('asc' as const) }
      : {};

  const detectedAtParam = search.detectedAt as string | undefined;
  const selectedDate = detectedAtParam ? new Date(Number(detectedAtParam)) : null;
  const filterParams =
    selectedDate === null || Number.isNaN(selectedDate.getTime())
      ? {}
      : (() => {
          const { from, to } = localDayRange(selectedDate);
          return { detectedAtFrom: from.getTime(), detectedAtTo: to.getTime() };
        })();

  return { ...sortParams, ...filterParams };
}

/**
 * Recent rule-stamped events (`market_events` where `rule_id IS NOT NULL`) —
 * loxep-7dp.6's opportunities dashboard, reading `fetchOpportunityEvents`
 * (`@/server/market-functions`). Score comes from `payload.opportunity`,
 * the block `stampEventWithRule` (`@loxep/market/opportunities.ts`) writes.
 * Sorting (`rule`/`score`/`detectedAt`) and the `detectedAt` date filter are
 * server-truthful over the full dataset (loxep-foi.7): both are read from
 * the URL here, before the query fires.
 */
export default function OpportunitiesTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const serverPage = Math.max(0, page - 1);
  const sortAndFilterParams = opportunitySortAndFilterParams(search);

  const { data, isPending, isError, error, refetch } = useQuery(
    opportunityEventsQuery({ page: serverPage, ...sortAndFilterParams })
  );

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
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  const { table } = useDataTable({
    data: data.events,
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
