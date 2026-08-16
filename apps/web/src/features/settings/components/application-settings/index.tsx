import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { applicationSettingsQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import type { RawSettingDto, RegisteredSettingDto } from '@/server/admin-functions';
import {
  ADVANCED_REGISTERED_KEYS,
  APPLICATION_SETTINGS_GROUPS,
  MANAGED_ELSEWHERE_SETTINGS,
  PROVISIONING_LINK
} from './groups';
import { getRegisteredColumns } from './registered-columns';
import { rawColumns } from './raw-columns';
import SettingEditDialog from './edit-dialog';
import GatusPushCard from './gatus-push-card';
import { SettingFormCard } from './setting-form-card';

const RAW_CLIENT_COLUMNS: ClientColumnSpec<RawSettingDto>[] = [
  { id: 'key', accessor: (row) => row.key, filterVariant: 'text' }
];
const ADVANCED_REGISTERED_CLIENT_COLUMNS: ClientColumnSpec<RegisteredSettingDto>[] = [
  { id: 'key', accessor: (row) => row.key, filterVariant: 'text' }
];

/** §2.5's reference conditional banner: `infrastructure.caa_policy` ships deliberately unreviewed. */
function caaPolicyBanner(values: Record<string, unknown>): React.ReactNode {
  if (values.reviewed === true) return null;
  return (
    <Alert variant='warning'>
      <AlertTitle>No CAA record is materialized until "reviewed" is on</AlertTitle>
      <AlertDescription>
        Confirm the certificate authorities this estate actually uses — including any used
        indirectly by a proxying DNS provider or reverse proxy — then turn Reviewed on to start
        materializing CAA records on every managed domain.
      </AlertDescription>
    </Alert>
  );
}

function keysFor(heading: string): string[] {
  return APPLICATION_SETTINGS_GROUPS.find((group) => group.heading === heading)?.keys ?? [];
}

function SettingsGroup({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className='flex flex-col gap-3'>
      <h2 className='text-lg font-medium'>{heading}</h2>
      {children}
    </section>
  );
}

/**
 * A "Managed elsewhere" row (settings-ux-design.md §3): the setting's own
 * key/description in the same Card shell every class (a) setting uses, but
 * the body is a link to the real editing surface instead of a form — never
 * a dead-end JSON dialog for a setting that already has a real control
 * somewhere else.
 */
function SettingLinkCard({
  setting,
  to,
  label
}: {
  setting: RegisteredSettingDto;
  to: string;
  label: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='font-mono text-sm break-all'>{setting.key}</CardTitle>
        <CardDescription>{setting.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant='outline' size='sm'>
          <Link to={to}>{label}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Application settings (ADR-0016): grouped Cards over the typed registry
 * (`defineSetting`) — every class (a) setting on the generic schema-driven
 * form (settings-ux-design.md §2), the class (b) composites that already
 * live on this page unchanged (`GatusPushCard`, `infrastructure.caa_policy`'s
 * banner), the two record-shaped settings pointing at their real editors
 * ("Managed elsewhere"), `auth.provisioning` linking to where it actually
 * lives (`/settings/users`, "link, don't duplicate"), and a collapsed
 * "Advanced" section preserving the old raw-JSON path for raw/unregistered
 * rows plus the two registered settings with no dedicated form yet
 * (`integration.tailscale.ignored_devices`, class c permanently;
 * `infrastructure.ip_aliases`, until loxep-8ja.5 ships its own CRUD).
 */
export default function ApplicationSettings({ isAdmin }: { isAdmin: boolean }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const [editingAdvanced, setEditingAdvanced] = React.useState<RegisteredSettingDto | null>(null);

  const { data, isPending, isError, error, refetch } = useQuery(applicationSettingsQuery);

  if (isPending) {
    return (
      <div className='flex flex-col gap-4'>
        <Skeleton className='h-48 w-full' />
        <Skeleton className='h-48 w-full' />
        <Skeleton className='h-48 w-full' />
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

  const byKey = new Map(data.registered.map((setting) => [setting.key, setting] as const));

  function card(
    key: string,
    opts?: { banner?: (values: Record<string, unknown>) => React.ReactNode }
  ) {
    const setting = byKey.get(key);
    if (setting === undefined) return null;
    return <SettingFormCard key={key} setting={setting} isAdmin={isAdmin} banner={opts?.banner} />;
  }

  const advancedRegistered = ADVANCED_REGISTERED_KEYS.map((key) => byKey.get(key)).filter(
    (setting): setting is RegisteredSettingDto => setting !== undefined
  );

  return (
    <div className='flex flex-col gap-8'>
      <SettingsGroup heading='Marketplace polling'>
        <div className='grid gap-4 md:grid-cols-2'>
          {keysFor('Marketplace polling').map((key) => card(key))}
        </div>
      </SettingsGroup>

      <SettingsGroup heading='Provider rate budgets'>
        <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-4'>
          {keysFor('Provider rate budgets').map((key) => card(key))}
        </div>
      </SettingsGroup>

      <SettingsGroup heading='Uploads'>
        <div className='grid gap-4 md:grid-cols-2'>
          {keysFor('Uploads').map((key) => card(key))}
        </div>
      </SettingsGroup>

      <SettingsGroup heading='Documents & inventory'>
        <div className='grid gap-4 md:grid-cols-2'>
          {keysFor('Documents & inventory').map((key) => card(key))}
        </div>
      </SettingsGroup>

      <SettingsGroup heading='Commerce'>
        <div className='grid gap-4'>{keysFor('Commerce').map((key) => card(key))}</div>
      </SettingsGroup>

      <SettingsGroup heading='Auth & provisioning'>
        <div className='flex flex-col gap-4'>
          {(() => {
            const provisioning = byKey.get(PROVISIONING_LINK.key);
            return provisioning ? (
              <SettingLinkCard
                setting={provisioning}
                to={PROVISIONING_LINK.to}
                label={PROVISIONING_LINK.label}
              />
            ) : null;
          })()}
          {keysFor('Auth & provisioning').map((key) => card(key))}
        </div>
      </SettingsGroup>

      <SettingsGroup heading='Infrastructure'>
        <div className='flex flex-col gap-4'>
          {keysFor('Infrastructure').map((key) => card(key, { banner: caaPolicyBanner }))}
          <GatusPushCard isAdmin={isAdmin} />
        </div>
      </SettingsGroup>

      <SettingsGroup heading='Managed elsewhere'>
        <div className='grid gap-4 md:grid-cols-2'>
          {MANAGED_ELSEWHERE_SETTINGS.map(({ key, to, label }) => {
            const setting = byKey.get(key);
            return setting ? (
              <SettingLinkCard key={key} setting={setting} to={to} label={label} />
            ) : null;
          })}
        </div>
      </SettingsGroup>

      <AdvancedSection
        raw={data.raw}
        advancedRegistered={advancedRegistered}
        isAdmin={isAdmin}
        search={search}
        page={page}
        perPage={perPage}
        onEdit={setEditingAdvanced}
      />

      {editingAdvanced !== null && (
        <SettingEditDialog
          key={editingAdvanced.key}
          open
          onOpenChange={(open) => {
            if (!open) setEditingAdvanced(null);
          }}
          setting={editingAdvanced}
        />
      )}
    </div>
  );
}

/**
 * The advanced/raw JSON escape hatch (settings-ux-design.md §3's last
 * paragraph): collapsed by default, labelled plainly, preserving today's
 * exact `RawTable` + `SettingEditDialog` behavior. Never removed, only
 * demoted — the generic Cards above are the front door, not the only door.
 */
function AdvancedSection({
  raw,
  advancedRegistered,
  isAdmin,
  search,
  page,
  perPage,
  onEdit
}: {
  raw: RawSettingDto[];
  advancedRegistered: RegisteredSettingDto[];
  isAdmin: boolean;
  search: Record<string, unknown>;
  page: number;
  perPage: number;
  onEdit: (setting: RegisteredSettingDto) => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className='rounded-lg border'>
      <CollapsibleTrigger className='flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-accent/50'>
        Raw settings (advanced)
        <Icons.chevronDown
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden='true'
        />
      </CollapsibleTrigger>
      <CollapsibleContent className='flex flex-col gap-4 border-t p-4'>
        {advancedRegistered.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className='text-base'>Registered, no dedicated form yet</CardTitle>
              <CardDescription>
                Edited as raw JSON, validated server-side against each setting's registered schema —
                a device-ignore list and named IP aliases, neither of which has its own editing
                surface on this page.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AdvancedRegisteredTable
                data={advancedRegistered}
                search={search}
                page={page}
                perPage={perPage}
                isAdmin={isAdmin}
                onEdit={onEdit}
              />
            </CardContent>
          </Card>
        )}

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
      </CollapsibleContent>
    </Collapsible>
  );
}

function AdvancedRegisteredTable({
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
    ADVANCED_REGISTERED_CLIENT_COLUMNS,
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
