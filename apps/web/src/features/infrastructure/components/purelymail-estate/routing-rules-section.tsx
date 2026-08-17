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

function RoutingRulesTable({
  connectionId,
  rules
}: {
  connectionId: string;
  rules: PurelymailEstateRoutingRuleDto[];
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(rules, CLIENT_COLUMNS, search, page, perPage);
  const { table } = useDataTable({
    data: rows,
    columns: purelymailRoutingRuleColumns(connectionId),
    pageCount,
    getRowId: (rule) => String(rule.id),
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Purelymail estate's ROUTING RULES section (Estate Browsers Design
 * §3.2) — `listRoutingRules`, account-wide. A Loxep-tracked row's "Delete…"
 * mounts `MailboxAdminService.deleteRoutingRule` (loxep-47o.11), destructive,
 * typed confirmation. `createRoutingRule` has no mounted affordance: the
 * design names no sanctioned section-level create home on this page (Rule
 * P10), so it ships at the service layer only, unmounted.
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
      {(rules) => <RoutingRulesTable connectionId={connectionId} rules={rules} />}
    </EstateSection>
  );
}
