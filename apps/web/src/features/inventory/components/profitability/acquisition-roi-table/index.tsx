import { useSearch } from '@tanstack/react-router';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { parseSortingState } from '@/lib/parsers';
import { sortRows } from '@/features/market/lib/sort-rows';
import type { AcquisitionRoiDto } from '@/server/inventory-functions';
import { buildAcquisitionRoiColumns, acquisitionRoiColumnIds } from './columns';

const DEFAULT_PAGE_SIZE = 10;

/**
 * The page's one primary, URL-synced table (page/perPage/sort) — every other
 * table on `/inventory/profitability` is a fixed, unfiltered worklist using
 * local `useTable` state instead, per Frontend Standards' "two tables on one
 * route" caveat.
 */
export default function AcquisitionRoiTable({
  rows,
  contributionLabel
}: {
  rows: AcquisitionRoiDto[];
  contributionLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.billing />
          </EmptyMedia>
          <EmptyTitle>No acquisitions yet</EmptyTitle>
          <EmptyDescription>
            ROI per lot appears here once an acquisition has depleted stock against a sale.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <AcquisitionRoiDataTable rows={rows} contributionLabel={contributionLabel} />;
}

function AcquisitionRoiDataTable({
  rows,
  contributionLabel
}: {
  rows: AcquisitionRoiDto[];
  contributionLabel: string;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? DEFAULT_PAGE_SIZE;
  const sortStr = search.sort as string | undefined;

  const sorting = parseSortingState<AcquisitionRoiDto>(sortStr, acquisitionRoiColumnIds);
  const sorted = sortRows(rows, sorting, {
    referenceCode: (row) => row.referenceCode,
    acquiredAt: (row) => row.acquiredAt,
    landedCostAmount: (row) => Number(row.landedCostAmount),
    onHandCostAmount: (row) => Number(row.onHandCostAmount),
    realizedContributionAmount: (row) => Number(row.realizedContributionAmount)
  });

  const pageCount = Math.max(1, Math.ceil(sorted.length / perPage));
  const pageRows = sorted.slice((page - 1) * perPage, page * perPage);

  const { table } = useDataTable({
    data: pageRows,
    columns: buildAcquisitionRoiColumns(contributionLabel),
    pageCount,
    getRowId: (row) => row.acquisitionId,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: DEFAULT_PAGE_SIZE }
    }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
