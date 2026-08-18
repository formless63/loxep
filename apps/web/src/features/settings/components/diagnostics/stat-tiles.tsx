import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons, type Icon } from '@/components/icons';
import { cn } from '@/lib/utils';
import { formatDuration, formatQuantity } from '@/lib/format';
import { jobStatsQuery } from '@/features/settings/api/diagnostics-queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';

/** The one grid-level tint (Frontend Standards, KPI cards) so the four tiles read as a group. */
const GRID_TINT =
  '[&_[data-slot=card]]:bg-gradient-to-t [&_[data-slot=card]]:from-primary/5 [&_[data-slot=card]]:to-card [&_[data-slot=card]]:shadow-xs dark:[&_[data-slot=card]]:bg-card';

function TileIcon({ icon: IconComponent, className }: { icon: Icon; className: string }) {
  return (
    <div className={cn('flex size-8 items-center justify-center rounded-full', className)}>
      <IconComponent className='size-4' />
    </div>
  );
}

function Tile({
  label,
  value,
  icon,
  iconClassName
}: {
  label: string;
  value: ReactNode;
  icon: Icon;
  iconClassName: string;
}) {
  return (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className='text-2xl font-semibold tabular-nums'>{value}</CardTitle>
        <CardAction>
          <TileIcon icon={icon} className={iconClassName} />
        </CardAction>
      </CardHeader>
    </Card>
  );
}

function TileSkeleton() {
  return (
    <Card className='h-full'>
      <CardHeader>
        <Skeleton className='h-4 w-24' />
        <Skeleton className='mt-2 h-7 w-16' />
      </CardHeader>
    </Card>
  );
}

/**
 * The four `getJobStats`-shaped numbers (`pending`/`running`/`failed`/
 * `oldestPendingSeconds`), read directly from `graphile_worker.jobs` by
 * `fetchJobStats` — see `@/server/diagnostics-functions`'s module doc for why
 * this does not call `@loxep/jobs`' `getJobStats` verb.
 */
export default function DiagnosticsStatTiles() {
  const { data, isPending, isError, error, refetch } = useQuery(jobStatsQuery);

  if (isError) {
    return (
      <QueryErrorAlert
        error={error}
        title='Could not load job statistics'
        onRetry={() => refetch()}
      />
    );
  }

  if (isPending) {
    return (
      <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-4', GRID_TINT)}>
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
        <TileSkeleton />
      </div>
    );
  }

  return (
    <div className={cn('grid grid-cols-2 gap-3 md:grid-cols-4', GRID_TINT)}>
      <Tile
        label='Pending'
        value={formatQuantity(data.pending)}
        icon={Icons.clock}
        iconClassName='bg-chart-1/15 text-chart-1'
      />
      <Tile
        label='Running'
        value={formatQuantity(data.running)}
        icon={Icons.pulse}
        iconClassName='bg-chart-2/15 text-chart-2'
      />
      <Tile
        label='Failed'
        value={formatQuantity(data.failed)}
        icon={Icons.warning}
        iconClassName={
          data.failed > 0 ? 'bg-destructive/15 text-destructive' : 'bg-chart-3/15 text-chart-3'
        }
      />
      <Tile
        label='Oldest pending'
        value={formatDuration(data.oldestPendingSeconds)}
        icon={Icons.server}
        iconClassName='bg-chart-4/15 text-chart-4'
      />
    </div>
  );
}
