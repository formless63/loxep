import type { ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { BooleanStatusBadge, ToneBadge } from '@/features/settings/components/status-tone';
import { formatRelativeTime } from '@/lib/format';
import { toastError } from '@/lib/errors';
import { setTailscaleDeviceIgnored } from '@/server/infrastructure-functions';
import type { DataTableFeatures } from '@/lib/table-features';
import type { TailscaleEstateDeviceDto } from '@/server/tailscale-estate-functions';

export interface TailscaleEstateColumnHandlers {
  onLink: (device: TailscaleEstateDeviceDto) => void;
  onDeclare: (device: TailscaleEstateDeviceDto) => void;
  /** Called after a successful ignore/unignore mutation so the section can re-read its own live query. */
  onIgnoreChanged: () => void;
}

/**
 * The one-row-per-device status/actions cell (loxep-47o.6). Unlike the
 * candidates panel's `CellAction` (which shows only the UNLINKED remainder),
 * this page's rows carry THREE possible states — linked, ignored, or a
 * plain candidate — because the whole tailnet renders here (Rule P2/§3.6).
 * "Ignore"/"Unignore" is a direct mutation on `setTailscaleDeviceIgnored`
 * (the SAME server function the candidates panel calls, Rule P10); "Link"/
 * "Declare" open dialogs the section component owns (they need a target
 * list / the new-hosting-target form).
 */
function DeviceActionsCell({
  device,
  onLink,
  onDeclare,
  onIgnoreChanged
}: TailscaleEstateColumnHandlers & { device: TailscaleEstateDeviceDto }) {
  const ignoreMutation = useMutation({
    mutationFn: (ignored: boolean) =>
      setTailscaleDeviceIgnored({ data: { externalId: device.externalDeviceId, ignored } }),
    onSuccess: (_result, ignored) => {
      toast.success(ignored ? 'Ignored' : 'Un-ignored');
      onIgnoreChanged();
    },
    onError: (error) => toastError(error, 'Failed to update')
  });

  if (device.linked !== null) {
    return (
      <Link
        to='/infrastructure/fleet/$name'
        params={{ name: device.linked.hostingTargetName }}
        className='text-sm underline-offset-4 hover:underline'
      >
        Linked to {device.linked.hostingTargetName}
      </Link>
    );
  }

  if (device.ignoredAt !== null) {
    return (
      <div className='flex items-center justify-end gap-2'>
        <span className='text-muted-foreground text-xs'>
          Ignored {formatRelativeTime(device.ignoredAt)}
        </span>
        <Button
          size='sm'
          variant='ghost'
          disabled={ignoreMutation.isPending}
          onClick={() => ignoreMutation.mutate(false)}
        >
          Unignore
        </Button>
      </div>
    );
  }

  const noExternalResource = device.externalResourceId === null;

  return (
    <div className='flex justify-end gap-2'>
      <Button
        size='sm'
        variant='outline'
        disabled={noExternalResource}
        onClick={() => onLink(device)}
      >
        Link
      </Button>
      <Button
        size='sm'
        variant='outline'
        disabled={noExternalResource}
        onClick={() => onDeclare(device)}
      >
        Declare
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={ignoreMutation.isPending}
        onClick={() => ignoreMutation.mutate(true)}
      >
        Ignore
      </Button>
    </div>
  );
}

export function tailscaleEstateColumns(
  handlers: TailscaleEstateColumnHandlers
): ColumnDef<DataTableFeatures, TailscaleEstateDeviceDto>[] {
  return [
    {
      id: 'device',
      header: 'Device',
      cell: ({ row }) => (
        <span className='font-medium'>
          {row.original.title ??
            row.original.name ??
            row.original.hostname ??
            row.original.externalDeviceId}
        </span>
      )
    },
    {
      id: 'addresses',
      header: 'Tailnet address',
      // Rule 3.6's CGNAT rule: rendered verbatim, plain text, NEVER a
      // copy-to-clipboard or "use as address" affordance — a published
      // 100.64.0.0/10 address in hosting_targets.address_v4/v6 is an outage
      // that presents as a propagation problem.
      cell: ({ row }) => (
        <span className='text-muted-foreground font-mono text-sm'>
          {row.original.addresses.length > 0 ? row.original.addresses.join(', ') : '—'}
        </span>
      )
    },
    {
      id: 'os',
      header: 'OS',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>{row.original.os ?? '—'}</span>
      )
    },
    {
      id: 'online',
      header: 'Online',
      cell: ({ row }) => {
        const { online } = row.original;
        return (
          <BooleanStatusBadge
            value={online}
            trueLabel='online'
            falseLabel='offline'
            falseTone='outline'
          />
        );
      }
    },
    {
      id: 'lastSeen',
      header: 'Last seen',
      cell: ({ row }) => {
        const { online, lastSeen } = row.original;
        if (online) return <span className='text-muted-foreground text-sm'>—</span>;
        return (
          <span className='text-muted-foreground text-sm'>
            {lastSeen ? formatRelativeTime(lastSeen) : '—'}
          </span>
        );
      }
    },
    {
      id: 'authorized',
      header: 'Authorized',
      cell: ({ row }) => {
        const { authorized } = row.original;
        if (authorized === null) return <ToneBadge tone='outline'>unknown</ToneBadge>;
        return (
          <Badge variant={authorized ? 'secondary' : 'destructive'}>{String(authorized)}</Badge>
        );
      }
    },
    {
      id: 'status',
      header: '',
      cell: ({ row }) => <DeviceActionsCell device={row.original} {...handlers} />
    }
  ];
}
