import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import {
  applyClientTableState,
  type ClientColumnSpec
} from '@/features/settings/lib/client-data-table';
import { EstateSection } from '@/features/estate/components/estate-section';
import { tailscaleEstateDevicesQuery } from '@/features/infrastructure/api/queries';
import NewHostingTargetDialog from '@/features/infrastructure/components/new-hosting-target-dialog';
import LinkDeviceDialog from '@/features/infrastructure/components/unmatched-devices-panel/link-device-dialog';
import { attachDiscoveredFleetResource } from '@/server/infrastructure-functions';
import type { UnmatchedTailscaleDeviceDto } from '@/server/infrastructure-functions';
import type { TailscaleEstateDeviceDto } from '@/server/tailscale-estate-functions';
import { tailscaleEstateColumns } from './columns';

const CLIENT_COLUMNS: ClientColumnSpec<TailscaleEstateDeviceDto>[] = [
  {
    id: 'device',
    accessor: (row) => row.title ?? row.name ?? row.hostname ?? row.externalDeviceId,
    filterVariant: 'text'
  }
];

/** `§1.1`'s "first label of the MagicDNS name" heuristic — the candidates panel's own declare-time name suggestion, duplicated here (not exported there). */
function firstLabel(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.indexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/**
 * Reshapes an estate row into the shape `LinkDeviceDialog`/
 * `NewHostingTargetDialog.onCreated` already expect (Rule P12 — mount the
 * EXISTING candidates-panel dialogs, never re-implement their write path).
 * Structurally compatible: both dialogs read only `id`/`externalId`/`title`/
 * `magicDnsName`/`os`/`authorized`/`online`/`lastSeen`/`ignoredAt` off the
 * object they are handed.
 */
function toUnmatchedShape(device: TailscaleEstateDeviceDto): UnmatchedTailscaleDeviceDto {
  return {
    id: device.externalResourceId as string,
    externalId: device.externalDeviceId,
    title: device.title,
    addresses: device.addresses,
    magicDnsName: device.name,
    os: device.os,
    authorized: device.authorized,
    online: device.online,
    lastSeen: device.lastSeen,
    observedAt: null,
    url: device.url,
    ignoredAt: device.ignoredAt
  };
}

function DevicesTable({
  devices,
  onLink,
  onDeclare,
  onIgnoreChanged
}: {
  devices: TailscaleEstateDeviceDto[];
  onLink: (device: TailscaleEstateDeviceDto) => void;
  onDeclare: (device: TailscaleEstateDeviceDto) => void;
  onIgnoreChanged: () => void;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const page = (search.page as number) ?? 1;
  const perPage = (search.perPage as number) ?? 10;
  const { rows, pageCount } = applyClientTableState(devices, CLIENT_COLUMNS, search, page, perPage);
  const { table } = useDataTable({
    data: rows,
    columns: tailscaleEstateColumns({ onLink, onDeclare, onIgnoreChanged }),
    pageCount,
    getRowId: (device) => device.externalDeviceId,
    shallow: true,
    debounceMs: 500
  });
  return <DataTable table={table} />;
}

/**
 * The Tailscale estate's TAILNET section (Estate Browsers Design §3.6) — the
 * whole tailnet from a single `listDevices()` call, including devices
 * already linked to a hosting target and devices the operator has ignored
 * (Rule P2: this page shows the whole connection, unlike the fleet-list
 * candidates panel's unlinked-only remainder). Link/Declare/Ignore mount the
 * EXACT SAME server functions that panel already calls
 * (`attachDiscoveredFleetResource`, `setTailscaleDeviceIgnored`) — no new
 * write of any kind (Rule P10).
 */
export default function TailscaleDevicesSection({ connectionId }: { connectionId: string }) {
  const queryClient = useQueryClient();
  const query = tailscaleEstateDevicesQuery(connectionId);
  const { data, isPending, isError, error, refetch } = useQuery(query);
  const [linkTarget, setLinkTarget] = React.useState<TailscaleEstateDeviceDto | null>(null);
  const [declareTarget, setDeclareTarget] = React.useState<TailscaleEstateDeviceDto | null>(null);

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: query.queryKey });
  }

  return (
    <EstateSection
      title='Tailnet'
      description="Live from Tailscale's listDevices() — the whole tailnet, in one call."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={(devices) => devices.length === 0}
      emptyMessage='This tailnet has no devices.'
    >
      {(devices) => (
        <>
          <DevicesTable
            devices={devices}
            onLink={setLinkTarget}
            onDeclare={setDeclareTarget}
            onIgnoreChanged={() => void refresh()}
          />
          {linkTarget && linkTarget.externalResourceId !== null && (
            <LinkDeviceDialog
              open={linkTarget !== null}
              onOpenChange={(next) => {
                if (!next) {
                  setLinkTarget(null);
                  void refresh();
                }
              }}
              device={toUnmatchedShape(linkTarget)}
            />
          )}
          {declareTarget && declareTarget.externalResourceId !== null && (
            <NewHostingTargetDialog
              key={declareTarget.externalResourceId}
              open={declareTarget !== null}
              onOpenChange={(next) => {
                if (!next) {
                  setDeclareTarget(null);
                  void refresh();
                }
              }}
              initialName={firstLabel(
                declareTarget.title ?? declareTarget.name ?? declareTarget.externalDeviceId
              )}
              onCreated={async (createdTarget) => {
                try {
                  await attachDiscoveredFleetResource({
                    data: {
                      hostingTargetId: createdTarget.id,
                      externalResourceId: declareTarget.externalResourceId as string
                    }
                  });
                } finally {
                  await refresh();
                }
              }}
            />
          )}
        </>
      )}
    </EstateSection>
  );
}
