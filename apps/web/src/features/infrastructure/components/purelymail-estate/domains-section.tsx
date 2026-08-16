import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { purelymailEstateDomainsQuery } from '@/features/infrastructure/api/queries';
import type { PurelymailEstateDomainDto } from '@/server/purelymail-estate-functions';
import { purelymailDomainColumns } from './domains-columns';

const CLIENT_COLUMNS: ClientColumnSpec<PurelymailEstateDomainDto>[] = [
  { id: 'name', accessor: (row) => row.name, filterVariant: 'text' }
];

function DomainsTable({
  connectionId,
  domains
}: {
  connectionId: string;
  domains: PurelymailEstateDomainDto[];
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(domains, CLIENT_COLUMNS, search, page, perPage);
  const { table } = useDataTable({
    data: rows,
    columns: purelymailDomainColumns(connectionId),
    pageCount,
    getRowId: (domain) => domain.name,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Purelymail estate's DOMAINS section (Estate Browsers Design §3.2) —
 * `listDomains`, account-wide, cross-referenced against `managed_domains`/
 * `mail_domains`. "Sync now"/"Sync mailboxes" mount the already-gated mail
 * reconciler for a domain already registered on THIS connection (Rule P10).
 */
export default function PurelymailDomainsSection({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    purelymailEstateDomainsQuery(connectionId)
  );

  return (
    <EstateSection
      title='Domains'
      description="Live from Purelymail's listDomains()."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(domains) => domains.length === 0}
      emptyMessage='This account has no domains yet.'
    >
      {(domains) => <DomainsTable connectionId={connectionId} domains={domains} />}
    </EstateSection>
  );
}
