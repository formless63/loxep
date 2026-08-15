import type { ColumnDef } from '@tanstack/react-table';
import { BooleanStatusBadge, ToneBadge } from '@/features/settings/components/status-tone';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { UnmatchedTailscaleDeviceDto } from '@/server/infrastructure-functions';
import { CellAction, type CellActionHandlers } from './cell-action';

/**
 * The candidates panel's columns (loxep-50t §4's "device name / hostname /
 * tailnet address / online / lastSeen / os"). `hostname` is not rendered as
 * its own column — see `UnmatchedTailscaleDeviceDto`'s doc for why it is not
 * available separately from `title` today.
 */
export function getColumns(
  handlers: CellActionHandlers
): ColumnDef<DataTableFeatures, UnmatchedTailscaleDeviceDto>[] {
  return [
    {
      id: 'device',
      header: 'Device',
      cell: ({ row }) => (
        <span className='font-medium'>
          {row.original.title ??
            row.original.magicDnsName ??
            row.original.externalId ??
            'Unknown device'}
        </span>
      )
    },
    {
      id: 'address',
      header: 'Tailnet address',
      cell: ({ row }) => (
        <span className='text-muted-foreground font-mono text-sm'>
          {row.original.addresses.length > 0 ? row.original.addresses.join(', ') : '—'}
        </span>
      )
    },
    {
      id: 'online',
      header: 'Online',
      cell: ({ row }) => {
        const { online } = row.original;
        if (online === null) return <ToneBadge tone='outline'>unknown</ToneBadge>;
        // `offline` is a normal, expected state for a personal device (a
        // phone asleep overnight) — never the alarm-red `destructive` tone,
        // matching the panel's "opt-in, not a nag" framing.
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
      id: 'os',
      header: 'OS',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>{row.original.os ?? '—'}</span>
      )
    },
    {
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} {...handlers} />
    }
  ];
}
