import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTable } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DataTable } from '@/components/ui/table/data-table';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { dataTableFeatures } from '@/lib/table-features';
import { unmatchedTailscaleDevicesQuery } from '@/features/infrastructure/api/queries';
import NewHostingTargetDialog from '@/features/infrastructure/components/new-hosting-target-dialog';
import { attachDiscoveredFleetResource } from '@/server/infrastructure-functions';
import type { UnmatchedTailscaleDeviceDto } from '@/server/infrastructure-functions';
import { getColumns } from './columns';
import LinkDeviceDialog from './link-device-dialog';

/** `§1.1`'s "first label of the MagicDNS name" heuristic, reused as a sane declare-time name suggestion. */
function firstLabel(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/**
 * The fleet LIST page's opt-in unmatched-devices candidates panel
 * (loxep-50t §4) — Tailscale devices Loxep has discovered
 * (`projectTailscaleDevices`'s upsert, every sweep) but never linked to a
 * hosting target. Follows the documents→expenses candidate queue's shape
 * (a panel wrapping a DataTable, per-row disposition, skip-and-count
 * mutations) and `dns-drift-panel.tsx`'s two-verb "promote or silence an
 * observation" posture for ignore.
 *
 * **Opt-in, collapsed by default, never a nag** — 1au's binding rule 3,
 * which this design explicitly shares (§4's own words: "the panel is the
 * deliverable, not the computation" — the counterpoint failure mode being
 * `ContainerHostPlan.unmatchedObserved`, computed and never surfaced). No
 * badge is added anywhere on the `/infrastructure` nav for this count; the
 * count shown here, inside a panel the operator chose to open, is this
 * panel's whole reason to exist.
 *
 * Renders nothing when there is genuinely nothing to show (no tailscale
 * connection has ever swept a device) — absent, not an empty shell, the same
 * "absent renders absent" rule the fleet signals band follows.
 */
export default function UnmatchedTailscaleDevicesPanel() {
  const queryClient = useQueryClient();
  const { data, isPending, isError } = useQuery(unmatchedTailscaleDevicesQuery);
  const [open, setOpen] = React.useState(false);
  const [showIgnored, setShowIgnored] = React.useState(false);
  const [linkTarget, setLinkTarget] = React.useState<UnmatchedTailscaleDeviceDto | null>(null);
  const [declareTarget, setDeclareTarget] = React.useState<UnmatchedTailscaleDeviceDto | null>(
    null
  );

  // A loading or failed read of an OPT-IN panel must not itself nag the
  // operator with a skeleton or an alert on a page they have not asked this
  // panel anything of yet — it simply does not render until it has
  // something to say. The same data feeds nothing else on this route, so a
  // genuine outage here is silent rather than surfaced twice. Sequential
  // early returns (not one combined `||`) so TypeScript narrows `data` to
  // its defined, non-pending shape below.
  if (isPending) return null;
  if (isError) return null;
  if (data.length === 0) return null;

  const candidates = data.filter((device) => device.ignoredAt === null);
  const ignored = data.filter((device) => device.ignoredAt !== null);
  const visible = showIgnored ? data : candidates;

  const columns = getColumns({ onLink: setLinkTarget, onDeclare: setDeclareTarget });

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className='rounded-xl border bg-card py-6 text-card-foreground shadow-sm'
    >
      <CollapsibleTrigger className='flex w-full items-center justify-between gap-2 px-6 text-left'>
        <div className='space-y-1'>
          <p className='text-base leading-none font-semibold'>
            Unmatched tailnet devices
            {candidates.length > 0 && (
              <span className='text-muted-foreground ml-2 font-normal'>({candidates.length})</span>
            )}
          </p>
          <p className='text-muted-foreground text-sm'>
            Tailscale devices Loxep has discovered but has not linked to a hosting target.
          </p>
        </div>
        <Icons.chevronDown
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden='true'
        />
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-4 px-6 pt-4'>
        {ignored.length > 0 && (
          <Button size='sm' variant='ghost' onClick={() => setShowIgnored((value) => !value)}>
            {showIgnored ? 'Hide ignored' : `Show ignored (${ignored.length})`}
          </Button>
        )}
        {visible.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.circleCheck />
              </EmptyMedia>
              <EmptyTitle>Every discovered device is linked or ignored</EmptyTitle>
              <EmptyDescription>Nothing needs review right now.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DevicesDataTable rows={visible} columns={columns} />
        )}
      </CollapsibleContent>

      {linkTarget && (
        <LinkDeviceDialog
          open={linkTarget !== null}
          onOpenChange={(next) => !next && setLinkTarget(null)}
          device={linkTarget}
        />
      )}
      {declareTarget && (
        <NewHostingTargetDialog
          key={declareTarget.id}
          open={declareTarget !== null}
          onOpenChange={(next) => !next && setDeclareTarget(null)}
          initialName={firstLabel(
            declareTarget.title ?? declareTarget.magicDnsName ?? declareTarget.externalId ?? ''
          )}
          onCreated={async (createdTarget) => {
            try {
              await attachDiscoveredFleetResource({
                data: { hostingTargetId: createdTarget.id, externalResourceId: declareTarget.id }
              });
            } finally {
              // Whether or not the attach above succeeded, the hosting
              // target now exists — refresh the candidate list either way
              // (a successful attach removes the row; a failed one leaves it
              // linkable via "Link", which is the documented recovery path).
              await queryClient.invalidateQueries({
                queryKey: unmatchedTailscaleDevicesQuery.queryKey
              });
            }
          }}
        />
      )}
    </Collapsible>
  );
}

function DevicesDataTable({
  rows,
  columns
}: {
  rows: UnmatchedTailscaleDeviceDto[];
  columns: ReturnType<typeof getColumns>;
}) {
  // A small, in-memory candidate list (loxep-50t §4's own sizing note: "a
  // tailnet is tens to low hundreds of devices"), rendered through the
  // sanctioned `DataTable` shell but WITHOUT `useDataTable`'s URL-synced
  // page/perPage/sort — this panel shares its route with `FleetTable`,
  // which already owns those exact search-param keys, and two tables both
  // writing `page`/`sort` to the same URL would fight each other.
  // `useTable` + `manualPagination: true` with no `pageCount` is the
  // established local-table pattern for this shape (see
  // `apps/web/src/features/finance/components/expense-reports.tsx`'s
  // `MissingReceiptsList`/`UnallocatedExpensesList`): manual pagination
  // skips the row-model slicing entirely, so the DataTable shell renders
  // every row with no separate page/size state to own.
  const table = useTable({
    data: rows,
    columns,
    features: dataTableFeatures,
    manualPagination: true
  });

  return <DataTable table={table} />;
}
