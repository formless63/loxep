import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { purelymailEstateMailboxesQuery } from '@/features/infrastructure/api/queries';
import type {
  PurelymailEstateMailboxDto,
  PurelymailEstateMailboxesDto
} from '@/server/purelymail-estate-functions';
import { purelymailMailboxColumns } from './mailboxes-columns';

const CLIENT_COLUMNS: ClientColumnSpec<PurelymailEstateMailboxDto>[] = [
  { id: 'address', accessor: (row) => row.address, filterVariant: 'text' }
];

function MailboxesTable({ addresses }: { addresses: PurelymailEstateMailboxDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(
    addresses,
    CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const { table } = useDataTable({
    data: rows,
    columns: purelymailMailboxColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Purelymail estate's MAILBOXES section (Estate Browsers Design §3.2) —
 * `listUsers`, ACCOUNT-WIDE because the API has no per-domain filter, hard
 * cap `PURELYMAIL_LIST_USER_LIMIT` (Rule P8: a provider list that does not
 * paginate at all renders its one call's full result and states the cap —
 * never hides it). The unique fact this page adds: mailboxes that exist in
 * the account but correspond to no Loxep `mailboxes` row.
 */
export default function PurelymailMailboxesSection({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    purelymailEstateMailboxesQuery(connectionId)
  );

  return (
    <EstateSection
      title='Mailboxes'
      description="Live from Purelymail's listUsers() — account-wide, no per-domain filter exists."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(value: PurelymailEstateMailboxesDto) => value.addresses.length === 0}
      emptyMessage='This account has no mailboxes yet.'
    >
      {(value) => (
        <div className='flex flex-col gap-2'>
          <p className='text-muted-foreground text-sm'>
            Capped at {value.limit} addresses — Purelymail's listUser takes no paging parameter of
            any kind.
          </p>
          <MailboxesTable addresses={value.addresses} />
        </div>
      )}
    </EstateSection>
  );
}
