import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import RunStepsList from '@/features/infrastructure/components/run-steps-list';
import { SubjectCell } from '@/features/infrastructure/components/runs-table/columns';
import { reconcileRunQuery, reconcileRunsQuery } from '@/features/infrastructure/api/queries';
import { RUN_MODE_LABELS, RUN_STATUS_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { retryReconcileRun } from '@/server/infrastructure-functions';

export const Route = createFileRoute('/infrastructure/runs/$id')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(reconcileRunQuery(params.id));
  },
  errorComponent: RunDetailError,
  component: RunDetail
});

function DetailSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-24 w-full' />
      <Skeleton className='h-96 w-full' />
    </div>
  );
}

function RunDetailData({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(reconcileRunQuery(id));

  const retryMutation = useMutation({
    mutationFn: () => retryReconcileRun({ data: { id } }),
    onSuccess: async () => {
      toast.success('Retry enqueued');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: reconcileRunQuery(id).queryKey }),
        queryClient.invalidateQueries({ queryKey: reconcileRunsQuery.queryKey })
      ]);
    },
    onError: (error) => toastError(error, 'Could not retry this run')
  });

  const canRetry =
    data.subjectType === 'domain' ||
    data.subjectType === 'token' ||
    data.subjectType === 'hosting_target';

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <div className='flex flex-wrap items-center gap-2'>
            <CardTitle className='text-base'>{data.kind}</CardTitle>
            <ToneBadge tone={RUN_STATUS_TONE[data.status] ?? 'secondary'}>{data.status}</ToneBadge>
          </div>
          <CardDescription className='flex flex-wrap items-center gap-x-1'>
            <SubjectCell run={data} /> · {RUN_MODE_LABELS[data.mode] ?? data.mode} · triggered by{' '}
            {data.trigger} · started {formatDateTime(data.startedAt)}
            {data.finishedAt && ` · finished ${formatDateTime(data.finishedAt)}`}
            {` · ${data.stepCount} step${data.stepCount === 1 ? '' : 's'}`}
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          {data.errorSummary && (
            <Alert variant='destructive'>
              <AlertTitle>Run failed</AlertTitle>
              <AlertDescription>{data.errorSummary}</AlertDescription>
            </Alert>
          )}
          {canRetry && (
            <div>
              <Button
                size='sm'
                variant='outline'
                disabled={retryMutation.isPending}
                onClick={() => retryMutation.mutate()}
              >
                Retry
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <RunStepsList steps={data.steps} />
    </div>
  );
}

function RunDetail() {
  const { id } = Route.useParams();
  return (
    <InfrastructurePage title='Reconcile run' description='Steps, with retry.'>
      <React.Suspense fallback={<DetailSkeleton />}>
        <RunDetailData id={id} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function RunDetailError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage title='Reconcile run' description='Steps, with retry.'>
      <Alert variant='destructive'>
        <AlertTitle>Run unavailable</AlertTitle>
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
