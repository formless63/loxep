import * as React from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { FleetSignalsBand } from '@/features/infrastructure/components/fleet-signals-band';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import { infrastructureOverviewQuery } from '@/features/infrastructure/api/queries';
import {
  MANAGED_DOMAIN_STATE_LABELS,
  MANAGED_DOMAIN_STATE_TONE,
  RUN_STATUS_TONE
} from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { formatDateTime, formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { InfrastructureOverviewDto } from '@/server/infrastructure-functions';

export const Route = createFileRoute('/infrastructure/overview')({
  loader: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData(infrastructureOverviewQuery);
  },
  errorComponent: InfrastructureOverviewError,
  component: InfrastructureOverview
});

function StatTile({
  label,
  value,
  footer
}: {
  label: string;
  value: React.ReactNode;
  footer: string;
}) {
  return (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className='text-2xl font-semibold tabular-nums @[250px]/card:text-3xl'>
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className='text-muted-foreground text-sm'>{footer}</CardContent>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className='h-28 w-full' />
        ))}
      </div>
      <div className='flex flex-col gap-4'>
        <Skeleton className='h-5 w-40' />
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className='h-32 w-full' />
          ))}
        </div>
      </div>
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <Skeleton className='h-64 w-full' />
        <Skeleton className='h-64 w-full' />
      </div>
    </div>
  );
}

function OverviewContent({ data }: { data: InfrastructureOverviewDto }) {
  return (
    <div className='flex flex-col gap-4'>
      <div
        className={cn(
          'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4',
          '[&_[data-slot=card]]:bg-gradient-to-t [&_[data-slot=card]]:from-primary/5 [&_[data-slot=card]]:to-card [&_[data-slot=card]]:shadow-xs dark:[&_[data-slot=card]]:bg-card'
        )}
      >
        <StatTile
          label='Managed domains'
          value={formatQuantity(data.domainCount)}
          footer='Every domain Loxep declares intent for'
        />
        <StatTile
          label='Needs attention'
          value={formatQuantity(data.domainsNeedingAttentionCount)}
          footer='Not ready, or drifted from intent'
        />
        <StatTile
          label='Hosting targets'
          value={formatQuantity(data.hostingTargetCount)}
          footer='Active fleet entries'
        />
        <StatTile
          label='Unresolved drift'
          value={formatQuantity(data.unresolvedDriftCount)}
          footer='Findings across every domain'
        />
      </div>

      <FleetSignalsBand signals={data.fleetSignals} />

      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Domains needing attention</CardTitle>
            <CardDescription>Not yet ready, or diverged from intent.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.domainsNeedingAttention.length === 0 ? (
              <Empty className='p-0'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'>
                    <Icons.circleCheck />
                  </EmptyMedia>
                  <EmptyTitle>Every domain is ready</EmptyTitle>
                  <EmptyDescription>Nothing here is drifted or mid-provisioning.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className='flex flex-col gap-2'>
                {data.domainsNeedingAttention.map((domain) => (
                  <li key={domain.id}>
                    <Link
                      to='/infrastructure/domains/$name'
                      params={{ name: domain.name }}
                      className='flex items-center justify-between gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring'
                    >
                      <span className='font-medium'>{domain.name}</span>
                      <span className='flex items-center gap-2'>
                        {domain.driftDetectedAt && (
                          <Badge variant='destructive'>
                            <Icons.alertCircle />
                            drifted
                          </Badge>
                        )}
                        <ToneBadge tone={MANAGED_DOMAIN_STATE_TONE[domain.state] ?? 'secondary'}>
                          {MANAGED_DOMAIN_STATE_LABELS[domain.state] ?? domain.state}
                        </ToneBadge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Recent reconcile runs</CardTitle>
            <CardDescription>What the reconciler did, most recent first.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.recentRuns.length === 0 ? (
              <Empty className='p-0'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'>
                    <Icons.clock />
                  </EmptyMedia>
                  <EmptyTitle>No runs yet</EmptyTitle>
                  <EmptyDescription>
                    Runs appear once a domain provisions or a sweep executes.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className='flex flex-col gap-2'>
                {data.recentRuns.map((run) => (
                  <li key={run.id}>
                    <Link
                      to='/infrastructure/runs/$id'
                      params={{ id: run.id }}
                      className='flex items-center justify-between gap-2 rounded-md px-2 py-1.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring'
                    >
                      <span>
                        <span className='font-medium'>{run.kind}</span>
                        <span className='text-muted-foreground'>
                          {' '}
                          · {formatDateTime(run.startedAt)}
                        </span>
                      </span>
                      <ToneBadge tone={RUN_STATUS_TONE[run.status] ?? 'secondary'}>
                        {run.status}
                      </ToneBadge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className='grid grid-cols-1 gap-4 md:grid-cols-3'>
        <Link
          to='/infrastructure/domains'
          className='block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          <Card className='h-full transition-colors hover:bg-accent/50'>
            <CardHeader>
              <CardTitle className='text-base'>Domains</CardTitle>
              <CardDescription>
                Provisioning state, target, mail, and drift per domain.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link
          to='/infrastructure/fleet'
          className='block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          <Card className='h-full transition-colors hover:bg-accent/50'>
            <CardHeader>
              <CardTitle className='text-base'>Fleet</CardTitle>
              <CardDescription>
                Hosting targets a name can point at, and their minted tokens.
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
        <Link
          to='/infrastructure/runs'
          className='block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
        >
          <Card className='h-full transition-colors hover:bg-accent/50'>
            <CardHeader>
              <CardTitle className='text-base'>Reconcile runs</CardTitle>
              <CardDescription>Every apply and check run, with its steps.</CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>
    </div>
  );
}

/** Reads the suspense-cached query populated by the loader's `ensureQueryData` — see Frontend Standards, "Loading". */
function OverviewData() {
  const { data } = useSuspenseQuery(infrastructureOverviewQuery);
  return <OverviewContent data={data} />;
}

function InfrastructureOverview() {
  return (
    <InfrastructurePage
      title='Infrastructure'
      description='Fleet and domain health — what needs attention.'
    >
      <React.Suspense fallback={<OverviewSkeleton />}>
        <OverviewData />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function InfrastructureOverviewError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage
      title='Infrastructure'
      description='Fleet and domain health — what needs attention.'
    >
      <Alert variant='destructive'>
        <AlertTitle>Infrastructure overview unavailable</AlertTitle>
        <AlertDescription className='flex flex-col items-start gap-2'>
          <span>{error instanceof Error ? error.message : 'Unknown error'}</span>
          <Button variant='outline' size='sm' onClick={() => void router.invalidate()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    </InfrastructurePage>
  );
}
