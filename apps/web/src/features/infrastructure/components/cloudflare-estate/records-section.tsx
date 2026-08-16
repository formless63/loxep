import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { toastError } from '@/lib/errors';
import { EstateSection } from '@/features/estate/components/estate-section';
import { cloudflareEstateRecordsQuery } from '@/features/infrastructure/api/queries';
import { adoptCloudflareEstateRecord } from '@/server/cloudflare-estate-functions';
import type {
  CloudflareEstateRecordDto,
  CloudflareEstateRecordsDto
} from '@/server/cloudflare-estate-functions';
import { cloudflareRecordColumns } from './record-columns';

const CLIENT_COLUMNS: ClientColumnSpec<CloudflareEstateRecordDto>[] = [
  { id: 'type', accessor: (row) => row.type, filterVariant: 'multiSelect' },
  { id: 'fqdn', accessor: (row) => row.fqdn, filterVariant: 'text' },
  { id: 'crossReference', accessor: (row) => row.crossReference, filterVariant: 'multiSelect' }
];

function RecordsTable({
  data,
  onAdopt,
  canAdopt
}: {
  data: CloudflareEstateRecordsDto;
  onAdopt: (record: CloudflareEstateRecordDto) => void;
  canAdopt: boolean;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    data.records,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const columns = React.useMemo(
    () => cloudflareRecordColumns(onAdopt, canAdopt),
    [onAdopt, canAdopt]
  );
  const { table } = useDataTable({
    data: rows,
    columns,
    pageCount,
    getRowId: (record) => record.externalRecordId,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Cloudflare estate's RECORDS section — a PER-ZONE drill-in (Rule P6),
 * mounted only once an operator picks "View records" on a zone row. One
 * `read()` call per "Load more" page (Rule P8), cross-referenced against
 * Loxep's own `dns_records`/`dns_drift_findings` for whichever
 * `managed_domains` row (if any) this zone corresponds to.
 *
 * "Adopt" (Rule P10/P11) mounts `ManagedDomainsService.addManualRecord` —
 * the EXACT write `DnsDriftPanel`'s own Adopt button already makes — via
 * `adoptCloudflareEstateRecord`, a thin server function that adds no new
 * verb. It is offered only for `'unexpected'` rows in a zone that already
 * has a `managed_domains` row (`managedDomainId !== null`); a zone with no
 * managed domain has nowhere to write a `dns_records` row TO, and zone
 * creation is permanently out of scope for this page.
 */
export default function CloudflareRecordsSection({
  connectionId,
  externalZoneId,
  zoneName
}: {
  connectionId: string;
  externalZoneId: string;
  zoneName: string;
}) {
  const [maxPages, setMaxPages] = React.useState(1);
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(
    cloudflareEstateRecordsQuery(connectionId, externalZoneId, zoneName, maxPages)
  );

  const adoptMutation = useMutation({
    mutationFn: (record: CloudflareEstateRecordDto) => {
      if (data === undefined || data.status !== 'ok' || data.data.managedDomainId === null) {
        throw new Error('No managed domain to adopt this record into.');
      }
      return adoptCloudflareEstateRecord({
        data: {
          connectionId,
          domainId: data.data.managedDomainId,
          type: record.type,
          name: record.name,
          content: record.content,
          ttlSeconds: record.ttlSeconds,
          priority: record.priority,
          proxied: record.proxied,
          externalRecordId: record.externalRecordId
        }
      });
    },
    onSuccess: async () => {
      toast.success('Adopted — this record is now declared in Loxep.');
      // Only the RECORDS read needs a refetch: adopting a record changes
      // that one row's cross-reference (`unexpected` -> `declared`), never
      // the zone's own managed/not-declared status — the zone already had a
      // `managed_domains` row, or "Adopt" would not have been offered.
      await queryClient.invalidateQueries({
        queryKey: ['infrastructure', 'cloudflare-estate', connectionId, 'records', externalZoneId]
      });
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to adopt this record')
  });

  const managedDomainId =
    data !== undefined && data.status === 'ok' ? data.data.managedDomainId : null;

  return (
    <EstateSection
      title={`Records — ${zoneName}`}
      description="Live from Cloudflare's read() for this zone."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(value) => value.records.length === 0}
      emptyMessage='This zone has no DNS records.'
      children={(value) => (
        <div className='flex flex-col gap-3'>
          {managedDomainId === null && (
            <p className='text-muted-foreground text-sm'>
              No managed domain in Loxep for this zone yet — records show for reference; adopting is
              unavailable until a managed domain exists.
            </p>
          )}
          <RecordsTable
            data={value}
            onAdopt={(record) => adoptMutation.mutate(record)}
            canAdopt={managedDomainId !== null && !adoptMutation.isPending}
          />
          {value.hasMore && (
            <Button
              size='sm'
              variant='outline'
              className='self-start'
              onClick={() => setMaxPages((current) => current + 1)}
            >
              Load more records
            </Button>
          )}
        </div>
      )}
    />
  );
}
