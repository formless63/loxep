import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Line, LineChart } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartConfig, ChartContainer } from '@/components/ui/chart';
import { Link } from '@tanstack/react-router';
import { toastError } from '@/lib/errors';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import {
  containerHostRegistrationQuery,
  dockhandConnectionOptionsQuery
} from '@/features/infrastructure/api/queries';
import { RUN_STATUS_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import {
  declareContainerHostIntent,
  requestContainerHostReconcile
} from '@/server/infrastructure-functions';
import DockhandRegistrationFields, {
  emptyDockhandRegistrationValue,
  dockhandRegistrationToIntentInput,
  type DockhandRegistrationValue
} from './dockhand-registration-fields';

const containerHostRunsChartConfig = {
  health: { label: 'Run health', color: 'var(--chart-3)' }
} satisfies ChartConfig;

/** `succeeded` → 1, `failed` → 0, anything else (`partial`/`running`) → midline. */
function runHealthValue(status: string): number {
  if (status === 'succeeded') return 1;
  if (status === 'failed') return 0;
  return 0.5;
}

/**
 * `listRuns` already loads every run for this host to compute `lastRun`
 * (`fetchContainerHostRegistration`, `@/server/infrastructure-functions.ts`)
 * — this 20-run sparkline is free (loxep-8e2, priority 5's precedent,
 * mirroring `price-trend-cell.tsx`). `recentRuns` arrives most-recent-first;
 * reversed here so the strip reads chronologically left→right.
 */
function ContainerHostRunsSparkline({
  runs
}: {
  runs: { id: string; status: string; startedAt: string }[];
}) {
  if (runs.length < 2) return null;
  const data = runs
    .slice()
    .toReversed()
    .map((run) => ({ startedAt: run.startedAt, health: runHealthValue(run.status) }));
  return (
    <ChartContainer config={containerHostRunsChartConfig} className='aspect-auto h-7 w-[120px]'>
      <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          dataKey='health'
          type='monotone'
          stroke='var(--color-health)'
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * The fleet-detail "Container host registration" panel (hb7 §2.1(b), §2.6) —
 * the DURABLE home for the "register this host in Dockhand" intent. Unlike
 * `NewHostingTargetDialog`'s collapsed section (a one-shot, create-time
 * offer), this panel is required rather than optional: there is no
 * hosting-target edit form anywhere else, so a target created before a
 * Dockhand connection existed — or any subsequent edit — has nowhere else
 * to go. Also where drift, the last run, and the Reconcile / Check-now
 * actions live (hb7 §2.6's "only place in /infrastructure with a Dockhand
 * write button").
 *
 * ABSENT, not empty, when no Dockhand connection exists at all — the same
 * gate the create dialog's section uses (hb7 §2.1(a)), mirrored here so a
 * target on an installation with no Dockhand connection shows no dead form.
 */
export default function ContainerHostRegistrationPanel({
  hostingTargetId,
  hostingTargetName
}: {
  hostingTargetId: string;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();
  const { data: connections } = useQuery(dockhandConnectionOptionsQuery);
  const { data: registration } = useQuery(containerHostRegistrationQuery(hostingTargetId));
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState<DockhandRegistrationValue>(
    emptyDockhandRegistrationValue
  );

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: containerHostRegistrationQuery(hostingTargetId).queryKey
      }),
      queryClient.invalidateQueries({ queryKey: ['infrastructure', 'runs'] })
    ]);

  const declareMutation = useMutation({
    mutationFn: () =>
      declareContainerHostIntent({
        data: dockhandRegistrationToIntentInput(hostingTargetId, value)
      }),
    onSuccess: async () => {
      toast.success('Registration saved — reconciling now');
      setEditing(false);
      setValue(emptyDockhandRegistrationValue);
      await invalidate();
    },
    onError: (error) => toastError(error, 'Failed to save the registration')
  });

  const reconcileMutation = useMutation({
    mutationFn: (mode: 'apply' | 'check') =>
      requestContainerHostReconcile({ data: { hostingTargetId, mode } }),
    onSuccess: async (_result, mode) => {
      toast.success(mode === 'apply' ? 'Reconcile enqueued' : 'Check enqueued');
      await invalidate();
    },
    onError: (error) => toastError(error, 'Failed to enqueue')
  });

  if ((connections ?? []).length === 0) return null;

  const startEditing = () => {
    if (registration !== null && registration !== undefined) {
      setValue({
        connectionId: registration.connectionId,
        connectionType: registration.connectionType as DockhandRegistrationValue['connectionType'],
        socketPath: registration.socketPath ?? '',
        host: registration.host ?? '',
        port: registration.port !== null ? String(registration.port) : '',
        protocol: (registration.protocol as DockhandRegistrationValue['protocol']) ?? 'http',
        tlsSkipVerify: registration.tlsSkipVerify ?? false,
        labels: registration.labels.join(', '),
        publicIp: registration.publicIp ?? '',
        tlsCa: '',
        tlsCert: '',
        tlsKey: '',
        hawserToken: ''
      });
    } else {
      setValue(emptyDockhandRegistrationValue);
    }
    setEditing(true);
  };

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div>
            <CardTitle className='text-base'>Container host registration</CardTitle>
            <CardDescription>
              {registration === null || registration === undefined
                ? `Register "${hostingTargetName}" as a Dockhand-managed host.`
                : 'Desired state Loxep will keep converged with Dockhand.'}
            </CardDescription>
          </div>
          {registration !== null && registration !== undefined && !editing && (
            <div className='flex shrink-0 gap-2'>
              <Button
                size='sm'
                variant='outline'
                disabled={reconcileMutation.isPending}
                onClick={() => reconcileMutation.mutate('check')}
              >
                Check now
              </Button>
              <Button
                size='sm'
                disabled={reconcileMutation.isPending}
                onClick={() => reconcileMutation.mutate('apply')}
              >
                Reconcile
              </Button>
              <Button size='sm' variant='ghost' onClick={startEditing}>
                Edit
              </Button>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {editing || registration === null || registration === undefined ? (
          <div className='flex flex-col gap-4'>
            <DockhandRegistrationFields value={value} onChange={setValue} />
            <div className='flex justify-end gap-2'>
              {editing && (
                <Button variant='outline' onClick={() => setEditing(false)}>
                  Cancel
                </Button>
              )}
              <Button
                disabled={value.connectionId === '' || declareMutation.isPending}
                onClick={() => declareMutation.mutate()}
              >
                {registration === null || registration === undefined ? 'Register' : 'Save changes'}
              </Button>
            </div>
          </div>
        ) : (
          <div className='flex flex-col gap-3'>
            <div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm'>
              <span>
                <span className='font-medium text-foreground'>Connection: </span>
                {registration.connectionType}
              </span>
              {registration.host && (
                <span>
                  <span className='font-medium text-foreground'>Host: </span>
                  {registration.host}
                  {registration.port !== null && `:${registration.port}`}
                </span>
              )}
              {registration.socketPath && (
                <span>
                  <span className='font-medium text-foreground'>Socket: </span>
                  {registration.socketPath}
                </span>
              )}
              {registration.publicIp && (
                <span>
                  <span className='font-medium text-foreground'>Public IP: </span>
                  {registration.publicIp}
                </span>
              )}
              {registration.labels.length > 0 && (
                <span>
                  <span className='font-medium text-foreground'>Labels: </span>
                  {registration.labels.join(', ')}
                </span>
              )}
            </div>
            <div className='flex items-center gap-2'>
              {registration.externalHostId !== null ? (
                <Badge variant='success'>Registered</Badge>
              ) : (
                <Badge variant='outline'>Not yet confirmed at Dockhand</Badge>
              )}
              <span className='text-muted-foreground text-xs'>
                declared {formatRelativeTime(registration.desiredAt)}
                {registration.lastAppliedAt &&
                  ` · last applied ${formatRelativeTime(registration.lastAppliedAt)}`}
              </span>
            </div>
            {registration.lastRun ? (
              <div className='flex items-center gap-2 rounded-md border px-3 py-2 text-sm'>
                <ToneBadge tone={RUN_STATUS_TONE[registration.lastRun.status] ?? 'secondary'}>
                  {registration.lastRun.status}
                </ToneBadge>
                <span className='text-muted-foreground'>
                  {registration.lastRun.mode} · {registration.lastRun.trigger} ·{' '}
                  <span title={formatDateTime(registration.lastRun.startedAt)}>
                    {formatRelativeTime(registration.lastRun.startedAt)}
                  </span>
                </span>
                <Link
                  to='/infrastructure/runs/$id'
                  params={{ id: registration.lastRun.id }}
                  className='ml-auto underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
                >
                  View run
                </Link>
              </div>
            ) : (
              <p className='text-muted-foreground text-sm'>No reconcile run yet.</p>
            )}
            {registration.recentRuns.length >= 2 && (
              <div className='flex items-center gap-2'>
                <span className='text-muted-foreground text-xs'>
                  Last {registration.recentRuns.length} runs
                </span>
                <ContainerHostRunsSparkline runs={registration.recentRuns} />
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
