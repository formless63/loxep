import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { cloudflareEstateZonesQuery } from '@/features/infrastructure/api/queries';
import type {
  CloudflareEstateZoneDto,
  CloudflareEstateZonesDto
} from '@/server/cloudflare-estate-functions';
import { cloudflareZoneColumns } from './zone-columns';

const CLIENT_COLUMNS: ClientColumnSpec<CloudflareEstateZoneDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

function ZonesTable({
  data,
  selectedZoneId,
  onViewRecords
}: {
  data: CloudflareEstateZonesDto;
  selectedZoneId: string | null;
  onViewRecords: (zone: CloudflareEstateZoneDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    data.zones,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const columns = React.useMemo(
    () => cloudflareZoneColumns(onViewRecords, selectedZoneId),
    [onViewRecords, selectedZoneId]
  );
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (zone) => zone.externalZoneId,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Cloudflare estate's ZONES section (Estate Browsers Design §3.1) —
 * the overview: `listZones`, one page per operator "Load more" click (Rule
 * P8), cross-referenced against `managed_domains` for this connection. This
 * is the section that renders on first mount and costs exactly one
 * Cloudflare call, well inside Rule P7's 3-call overview budget.
 */
export default function CloudflareZonesSection({
  connectionId,
  selectedZoneId,
  onViewRecords
}: {
  connectionId: string;
  selectedZoneId: string | null;
  onViewRecords: (zone: CloudflareEstateZoneDto) => void;
}) {
  const [maxPages, setMaxPages] = React.useState(1);
  const { data, isPending, isError, error, refetch } = useQuery(
    cloudflareEstateZonesQuery(connectionId, maxPages)
  );

  return (
    <EstateSection
      title='Zones'
      description="Live from Cloudflare's listZones — every zone this account has, including ones Loxep has no managed domain for."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(value) => value.zones.length === 0}
      emptyMessage='This Cloudflare account has no zones.'
      children={(value) => (
        <div className='flex flex-col gap-3'>
          <ZonesTable data={value} selectedZoneId={selectedZoneId} onViewRecords={onViewRecords} />
          {value.hasMore && (
            <Button
              size='sm'
              variant='outline'
              className='self-start'
              onClick={() => setMaxPages((current) => current + 1)}
            >
              Load more zones
            </Button>
          )}
        </div>
      )}
    />
  );
}
