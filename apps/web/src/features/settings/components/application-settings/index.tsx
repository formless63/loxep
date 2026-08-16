import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { applicationSettingsQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { RawSettingDto, RegisteredSettingDto } from '@/server/admin-functions';
import { getRegisteredColumns, registeredColumns } from './registered-columns';
import { rawColumns } from './raw-columns';
import SettingEditDialog from './edit-dialog';
import SchemaSettingDialog from './schema-setting-dialog';
import GatusPushCard from './gatus-push-card';

const REGISTERED_CLIENT_COLUMNS: ClientColumnSpec<RegisteredSettingDto>[] = [
  { id: 'key', accessor: (row) => row.key, filterVariant: 'text' }
];
const RAW_CLIENT_COLUMNS: ClientColumnSpec<RawSettingDto>[] = [
  { id: 'key', accessor: (row) => row.key, filterVariant: 'text' }
];

/**
 * loxep-8ja.2 proof-of-concept: the one class (a) setting mounted on the
 * generic schema-driven form (`SchemaSettingDialog`) instead of the raw-JSON
 * dialog, proving the `jsonSchema` DTO wire end-to-end — `documents.parser_id`
 * is the smallest class (a) shape (settings-ux-design.md §1, row 12: one bare
 * string field). A literal, not an import of `documentsParserIdSetting.key`
 * from `@loxep/domain`: that package's VALUES stay server-side only (§2.1) —
 * this key is a plain string, the same shape every `RegisteredSettingDto.key`
 * already is. Every other registered setting keeps `SettingEditDialog` until
 * the grouped-Cards rebuild (loxep-8ja.3).
 */
const SCHEMA_FORM_POC_SETTING_KEY = 'documents.parser_id';

/**
 * Application settings (ADR-0016): the typed registry (`defineSetting`) plus
 * a read-only listing of raw `application_settings` rows for keys written
 * outside the registry (e.g. jobs' runtime.heartbeat) — keys and provenance
 * only, values deliberately uninterpreted.
 */
export default function ApplicationSettings({ isAdmin }: { isAdmin: boolean }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [editing, setEditing] = React.useState<RegisteredSettingDto | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery(applicationSettingsQuery);

  if (isPending) {
    return (
      <div className='flex flex-col gap-4'>
        <DataTableSkeleton columnCount={registeredColumns.length} filterCount={1} />
        <DataTableSkeleton columnCount={rawColumns.length} filterCount={1} />
      </div>
    );
  }

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Failed to load application settings'
        onRetry={() => refetch()}
      />
    );
  }

  const registered = data.registered;
  const raw = data.raw;

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Registered settings</CardTitle>
        </CardHeader>
        <CardContent>
          {registered.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.settings />
                </EmptyMedia>
                <EmptyTitle>No registered settings</EmptyTitle>
                <EmptyDescription>
                  Settings are declared in code through the typed registry (defineSetting) and
                  appear here as features register them — the registry is empty in this build.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RegisteredTable
              data={registered}
              search={search}
              page={page}
              perPage={perPage}
              isAdmin={isAdmin}
              onEdit={setEditing}
            />
          )}
        </CardContent>
      </Card>

      <GatusPushCard isAdmin={isAdmin} />

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Raw stored rows</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <p className='text-muted-foreground text-sm'>
            Every stored application_settings row — including keys written outside the registry —
            listed without value interpretation.
          </p>
          {raw.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.code />
                </EmptyMedia>
                <EmptyTitle>No rows stored yet</EmptyTitle>
                <EmptyDescription>
                  Rows appear here once any application setting is written, in or out of the
                  registry.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RawTable data={raw} search={search} page={page} perPage={perPage} />
          )}
        </CardContent>
      </Card>

      {editing !== null &&
        (editing.key === SCHEMA_FORM_POC_SETTING_KEY ? (
          <SchemaSettingDialog
            key={editing.key}
            open
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            setting={editing}
          />
        ) : (
          // Keyed by setting: opening a different row remounts the form so
          // its textarea starts from that setting's own stored value.
          <SettingEditDialog
            key={editing.key}
            open
            onOpenChange={(open) => {
              if (!open) setEditing(null);
            }}
            setting={editing}
          />
        ))}
    </div>
  );
}

function RegisteredTable({
  data,
  search,
  page,
  perPage,
  isAdmin,
  onEdit
}: {
  data: RegisteredSettingDto[];
  search: Record<string, unknown>;
  page: number;
  perPage: number;
  isAdmin: boolean;
  onEdit: (setting: RegisteredSettingDto) => void;
}) {
  const { rows, pageCount } = applyClientTableState(
    data,
    REGISTERED_CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const { table } = useDataTable({
    data: rows,
    columns: getRegisteredColumns(isAdmin, onEdit),
    pageCount,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}

function RawTable({
  data,
  search,
  page,
  perPage
}: {
  data: RawSettingDto[];
  search: Record<string, unknown>;
  page: number;
  perPage: number;
}) {
  const { rows, pageCount } = applyClientTableState(
    data,
    RAW_CLIENT_COLUMNS,
    search,
    page,
    perPage
  );
  const { table } = useDataTable({
    data: rows,
    columns: rawColumns,
    pageCount,
    shallow: true,
    debounceMs: 500
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table} />
    </DataTable>
  );
}
