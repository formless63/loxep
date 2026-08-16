import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { purelymailEstateRoutingRulesQuery } from '@/features/infrastructure/api/queries';
import type { PurelymailEstateRoutingRuleDto } from '@/server/purelymail-estate-functions';
import { purelymailRoutingRuleColumns } from './routing-rules-columns';

const CLIENT_COLUMNS: ClientColumnSpec<PurelymailEstateRoutingRuleDto>[] = [
  {
    id: 'matchUser',
    accessor: (row) => `${row.matchUser}@${row.domainName}`,
    filterVariant: 'text'
  }
];

function RoutingRulesTable({ rules }: { rules: PurelymailEstateRoutingRuleDto[] }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(rules, CLIENT_COLUMNS, search, page, perPage);
  const { table } = useDataTable({
    data: rows,
    columns: purelymailRoutingRuleColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Purelymail estate's ROUTING RULES section (Estate Browsers Design
 * §3.2) — `listRoutingRules`, account-wide. Fully read-only: routing-rule
 * create/update/delete has no independent service-layer path outside
 * `runMailboxSync`'s own convergence loop, so no per-row action is offered
 * here (a follow-up bead covers that gap, filed against loxep-47o).
 */
export default function PurelymailRoutingRulesSection({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    purelymailEstateRoutingRulesQuery(connectionId)
  );

  return (
    <EstateSection
      title='Routing rules'
      description="Live from Purelymail's listRoutingRules() — account-wide."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(rules) => rules.length === 0}
      emptyMessage='This account has no routing rules yet.'
    >
      {(rules) => <RoutingRulesTable rules={rules} />}
    </EstateSection>
  );
}
