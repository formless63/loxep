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
import { estateConnectionSummaryQuery } from '@/features/estate/api/queries';
import { purelymailEstateRoutingRulesQuery } from '@/features/infrastructure/api/queries';
import { PROVIDER_WRITE_POLICY_TIER_VALUES } from '@/features/settings/constants';
import type { PurelymailEstateRoutingRuleDto } from '@/server/purelymail-estate-functions';
import { purelymailRoutingRuleColumns } from './routing-rules-columns';
import CreateRoutingRuleDialog from './create-routing-rule-dialog';

const ADDITIVE_RANK = PROVIDER_WRITE_POLICY_TIER_VALUES.indexOf('additive');

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
 * typed confirmation, tier `access_affecting`-or-higher.
 *
 * "New routing rule…" (loxep-4xo) mounts `MailboxAdminService.createRoutingRule`
 * — additive (tier 1), one tier below the delete. `blocked` is computed here
 * (from the SAME `estateConnectionSummaryQuery` the header/row actions
 * already fetch) and passed down so the dialog renders Rule P14's
 * visibly-blocked state before any click, matching every row action's own
 * pattern.
 */
export default function PurelymailRoutingRulesSection({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    purelymailEstateRoutingRulesQuery(connectionId)
  );
  const { data: summary } = useQuery(estateConnectionSummaryQuery(connectionId));
  const tier = summary?.writePolicy.tier ?? null;
  const tierRank = tier === null ? -1 : PROVIDER_WRITE_POLICY_TIER_VALUES.indexOf(tier);
  const createBlocked = tierRank < ADDITIVE_RANK;
  const [createOpen, setCreateOpen] = React.useState(false);

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
      headerAction={
        <div className='flex items-center gap-2'>
          <Button
            size='sm'
            variant='outline'
            disabled={createBlocked}
            title={
              createBlocked
                ? `Blocked: this connection's write policy must be "Additive writes" or higher to create a routing rule — raise it on Settings → Connections.`
                : undefined
            }
            onClick={() => setCreateOpen(true)}
          >
            New routing rule…
          </Button>
          {createBlocked && (
            <span className='text-muted-foreground text-xs'>blocked — needs additive tier</span>
          )}
          <CreateRoutingRuleDialog
            connectionId={connectionId}
            open={createOpen}
            onOpenChange={setCreateOpen}
            blocked={createBlocked}
          />
        </div>
      }
    >
      {(rules) => <RoutingRulesTable connectionId={connectionId} rules={rules} />}
    </EstateSection>
  );
}
