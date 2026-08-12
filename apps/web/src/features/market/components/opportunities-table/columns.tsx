import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { formatScore, formatTimestampPrecise } from '@/lib/format';
import { marketEventTypeLabel } from '@/features/settings/constants';
import {
  marketEventTypeIcon,
  marketEventTypeTone,
  scoreIcon,
  scoreTone
} from '@/features/market/constants';
import type { OpportunityEventDto } from '@/server/market-functions';

/**
 * Rule-stamped events, ranked by score (loxep-foi.3). Sorting on
 * `rule`/`score`/`detectedAt` and the `detectedAt` date filter apply to the
 * currently-fetched page only — see `applyClientSort`'s doc
 * (`../../lib/apply-client-sort.ts`) for why.
 */
export const columns: ColumnDef<OpportunityEventDto>[] = [
  {
    id: 'item',
    accessorFn: (row) => row.itemTitle ?? row.marketplaceItemId,
    header: 'Item',
    cell: ({ row }) => (
      <div className='flex flex-col gap-0.5'>
        <Link
          to='/market/items/$itemId'
          params={{ itemId: row.original.marketplaceItemId }}
          className='font-medium hover:underline'
        >
          {row.original.itemTitle ?? row.original.marketplaceItemId}
        </Link>
        {row.original.itemCanonicalUrl && (
          <a
            href={row.original.itemCanonicalUrl}
            target='_blank'
            rel='noreferrer'
            className='text-muted-foreground text-xs hover:underline'
          >
            View on eBay ↗
          </a>
        )}
      </div>
    )
  },
  {
    id: 'eventType',
    accessorKey: 'eventType',
    enableSorting: false,
    header: 'Event',
    cell: ({ cell }) => {
      const eventType = cell.getValue<OpportunityEventDto['eventType']>();
      const Icon = marketEventTypeIcon(eventType);
      return (
        <Badge variant={marketEventTypeTone(eventType)}>
          <Icon />
          {marketEventTypeLabel(eventType)}
        </Badge>
      );
    }
  },
  {
    id: 'rule',
    accessorKey: 'ruleName',
    header: ({ column }: { column: Column<OpportunityEventDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Rule' />
    ),
    cell: ({ cell }) => <span className='text-muted-foreground'>{cell.getValue<string>()}</span>
  },
  {
    id: 'score',
    accessorKey: 'score',
    header: ({ column }: { column: Column<OpportunityEventDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Score' />
    ),
    cell: ({ cell }) => {
      const score = cell.getValue<number>();
      const Icon = scoreIcon(score);
      return (
        <div className='flex justify-end'>
          <Badge variant={scoreTone(score)} className='tabular-nums'>
            <Icon />
            {formatScore(score)}
          </Badge>
        </div>
      );
    }
  },
  {
    id: 'reasons',
    accessorFn: (row) => (row.reasons.length > 0 ? row.reasons.join(', ') : '—'),
    enableSorting: false,
    header: 'Reasons',
    cell: ({ cell }) => (
      <span className='text-muted-foreground text-xs'>{cell.getValue<string>()}</span>
    )
  },
  {
    id: 'detectedAt',
    accessorKey: 'detectedAt',
    header: ({ column }: { column: Column<OpportunityEventDto, unknown> }) => (
      <DataTableColumnHeader column={column} title='Detected' />
    ),
    cell: ({ cell }) => (
      <span className='text-muted-foreground'>
        {formatTimestampPrecise(cell.getValue<string>())}
      </span>
    ),
    enableColumnFilter: true,
    meta: {
      label: 'Detected',
      variant: 'date',
      icon: Icons.calendar
    }
  }
];
