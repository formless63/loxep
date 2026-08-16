import type { ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import { formatRelativeTime } from '@/lib/format';
import type { DataTableFeatures } from '@/lib/table-features';
import type { TermixEstateHostDto } from '@/server/termix-estate-functions';

/**
 * Termix hosts columns (Estate Browsers Design §3.8) — read-only, no row
 * action of any kind: the design's own "Writes. None, ever" for this
 * provider covers Loxep-own writes too, not just Termix-directed ones.
 */
export const termixHostsColumns: ColumnDef<DataTableFeatures, TermixEstateHostDto>[] = [
  {
    id: 'name',
    header: 'Host',
    cell: ({ row }) => (
      <span className='font-medium'>{row.original.name ?? row.original.externalHostId}</span>
    )
  },
  {
    id: 'ip',
    header: 'IP',
    cell: ({ row }) => (
      <span className='text-muted-foreground font-mono text-sm'>{row.original.ip ?? '—'}</span>
    )
  },
  {
    id: 'online',
    header: 'Online',
    cell: ({ row }) => {
      const { online } = row.original;
      if (online === null) return <span className='text-muted-foreground text-sm'>unknown</span>;
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
    cell: ({ row }) => (
      <span className='text-muted-foreground text-sm'>
        {row.original.lastSeenAt ? formatRelativeTime(row.original.lastSeenAt) : '—'}
      </span>
    )
  },
  {
    id: 'loxep',
    header: '',
    cell: ({ row }) => {
      const { linked } = row.original;
      if (linked === null) {
        return <span className='text-muted-foreground text-sm'>Not linked</span>;
      }
      return (
        <Link
          to='/infrastructure/fleet/$name'
          params={{ name: linked.hostingTargetName }}
          className='text-sm underline-offset-4 hover:underline'
        >
          Linked to {linked.hostingTargetName}
        </Link>
      );
    }
  }
];
