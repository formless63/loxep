import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { gatusEstateEndpointsQuery } from '@/features/infrastructure/api/queries';
import type { GatusEstateEndpointDto } from '@/server/gatus-estate-functions';
import { gatusEndpointColumns } from './endpoint-columns';

const CLIENT_COLUMNS: ClientColumnSpec<GatusEstateEndpointDto>[] = [
  { id: 'key', accessor: (row) => row.key, filterVariant: 'text' }
];

function EndpointsTable({
  endpoints,
  selectedKey,
  onViewUptime
}: {
  endpoints: GatusEstateEndpointDto[];
  selectedKey: string | null;
  onViewUptime: (endpoint: GatusEstateEndpointDto) => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    endpoints,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const columns = React.useMemo(
    () => gatusEndpointColumns(onViewUptime, selectedKey),
    [onViewUptime, selectedKey]
  );
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (endpoint) => endpoint.key,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Gatus estate's ENDPOINTS section (Estate Browsers Design §3.7) —
 * `listEndpointStatuses()`, direct posture only, ONE call. Renders BLOCKED
 * (never an error) under OIDC — `gatus-estate-functions.ts` classifies that
 * specific refusal shape. The mandatory quarantine (loxep-1au Binding Rule
 * 1) is enforced server-side; `excludedHeartbeatCount` is the one-line
 * explanation this section renders rather than a silently shorter list.
 */
export default function GatusEndpointsSection({
  connectionId,
  selectedKey,
  onViewUptime
}: {
  connectionId: string;
  selectedKey: string | null;
  onViewUptime: (endpoint: GatusEstateEndpointDto) => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(
    gatusEstateEndpointsQuery(connectionId, 1, 100)
  );

  return (
    <EstateSection
      title='Endpoints'
      description="Live from Gatus's listEndpointStatuses() — direct posture only."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(value) => value.endpoints.length === 0}
      emptyMessage='This Gatus instance has no other endpoints configured.'
    >
      {(value) => (
        <div className='flex flex-col gap-3'>
          {value.excludedHeartbeatCount > 0 && (
            <p className='text-muted-foreground text-sm'>
              {value.excludedHeartbeatCount} endpoint{value.excludedHeartbeatCount === 1 ? '' : 's'}{' '}
              excluded — Loxep&apos;s own outward heartbeat, never shown here (loxep-1au binding
              rule 1: showing it would self-latch).
            </p>
          )}
          <EndpointsTable
            endpoints={value.endpoints}
            selectedKey={selectedKey}
            onViewUptime={onViewUptime}
          />
        </div>
      )}
    </EstateSection>
  );
}
