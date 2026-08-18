import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
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
import {
  auditEventsQuery,
  usersQuery,
  type AuditEventsFilterParams
} from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { DataTableFeatures } from '@/lib/table-features';
import type { AuditEventDto, AuditEventsPageDto } from '@/server/audit-functions';
import { createColumns } from './columns';

const AUDIT_PAGE_SIZE = 25;

/**
 * `occurredAt`'s `dateRange` filter writes `"<fromMs>,<toMs>"` into the URL
 * (`useDataTable`'s array-filter serialization, mirroring `orders-table`'s
 * `placedAt`) — parsed here into ISO strings and pushed into
 * `AuditReader.list`'s `from`/`to` server-side, unlike `orders-table`'s date
 * range (which filters an already-fetched, Phase-1-scale, unbounded result
 * client-side): `audit_events` grows with every configuration change ever
 * made and has no such volume ceiling, so an unbounded fetch would not be
 * honest here (Frontend Standards, "Tables").
 */
function parseOccurredAtRange(param: string | undefined): { from?: string; to?: string } {
  if (!param) return {};
  const [fromRaw, toRaw] = param.split(',');
  const fromMs = fromRaw ? Number(fromRaw) : undefined;
  const toMs = toRaw ? Number(toRaw) : undefined;
  return {
    from:
      fromMs !== undefined && !Number.isNaN(fromMs) ? new Date(fromMs).toISOString() : undefined,
    to: toMs !== undefined && !Number.isNaN(toMs) ? new Date(toMs).toISOString() : undefined
  };
}

/**
 * `/settings/audit` (loxep-161): every filter (actor, resource type, action,
 * date range) is read off the URL and pushed into `fetchAuditEvents` —
 * `useDataTable` always sets `manualFiltering: true`, so nothing here relies
 * on TanStack Table's own client-side filtering.
 */
export default function AuditTable() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const serverPage = Math.max(0, page - 1);
  const actorUserId = typeof search.actorUserId === 'string' ? search.actorUserId : undefined;
  const action = typeof search.action === 'string' ? search.action : undefined;
  const resourceType = typeof search.resourceType === 'string' ? search.resourceType : undefined;
  const { from, to } = parseOccurredAtRange(search.occurredAt as string | undefined);
  const hasActiveFilter = Boolean(actorUserId || action || resourceType || from || to);

  const filter: AuditEventsFilterParams = {
    page: serverPage,
    pageSize: AUDIT_PAGE_SIZE,
    actorUserId,
    action,
    resourceType,
    from,
    to
  };

  const { data: users } = useQuery(usersQuery);
  const { data, isPending, isError, error, refetch } = useQuery(auditEventsQuery(filter));

  const actorOptions = React.useMemo(
    () => (users ?? []).map((user) => ({ value: user.id, label: user.name })),
    [users]
  );
  const columns = React.useMemo(() => createColumns(actorOptions), [actorOptions]);

  if (isPending) {
    return <DataTableSkeleton columnCount={columns.length} filterCount={4} />;
  }
  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load audit events'
        onRetry={() => refetch()}
      />
    );
  }
  if (data.total === 0 && !hasActiveFilter) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.clock />
          </EmptyMedia>
          <EmptyTitle>No audit events yet</EmptyTitle>
          <EmptyDescription>
            Every configuration change — settings, connections, secrets, entities, and more — is
            recorded here the moment it happens.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return <AuditDataTable data={data} columns={columns} />;
}

function AuditDataTable({
  data,
  columns
}: {
  data: AuditEventsPageDto;
  columns: ColumnDef<DataTableFeatures, AuditEventDto>[];
}) {
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  const { table } = useDataTable({
    data: data.events,
    columns,
    pageCount,
    getRowId: (event) => event.id,
    shallow: true,
    debounceMs: 500,
    initialState: {
      pagination: { pageIndex: 0, pageSize: data.pageSize },
      columnPinning: { start: [], end: ['diff'] }
    }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
