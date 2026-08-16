import * as React from 'react';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import TemplateRunStepsList from '@/features/infrastructure/components/template-run-steps-list';
import { provisioningTemplateRunQuery } from '@/features/infrastructure/api/queries';
import { RUN_STATUS_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import {
  abandonProvisioningTemplateRun,
  resumeProvisioningTemplateRun
} from '@/server/provisioning-functions';

export const Route = createFileRoute('/infrastructure/templates/runs/$id')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(provisioningTemplateRunQuery(params.id));
  },
  errorComponent: RunDetailError,
  component: RunDetail
});

function DetailSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-32 w-full' />
      <Skeleton className='h-96 w-full' />
    </div>
  );
}

function RunDetailData({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const { data } = useSuspenseQuery(provisioningTemplateRunQuery(id));

  const resumeMutation = useMutation({
    mutationFn: () => resumeProvisioningTemplateRun({ data: { id } }),
    onSuccess: async () => {
      toast.success('Resume enqueued — advancing as far as it currently can');
      await queryClient.invalidateQueries({ queryKey: provisioningTemplateRunQuery(id).queryKey });
    },
    onError: (error) => toastError(error, 'Could not resume this run')
  });

  const abandonMutation = useMutation({
    mutationFn: () => abandonProvisioningTemplateRun({ data: { id } }),
    onSuccess: async () => {
      toast.success('Run abandoned');
      await queryClient.invalidateQueries({ queryKey: provisioningTemplateRunQuery(id).queryKey });
    },
    onError: (error) => toastError(error, 'Could not abandon this run')
  });

  const canResume = data.status === 'partial' || data.status === 'running';
  const canAbandon = data.status !== 'succeeded' && data.status !== 'failed';

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <div className='flex flex-wrap items-center gap-2'>
            <CardTitle className='text-base'>
              <Link
                to='/infrastructure/templates/$id'
                params={{ id: data.templateId }}
                className='outline-none hover:underline'
              >
                {data.templateName}
              </Link>
            </CardTitle>
            <ToneBadge tone={RUN_STATUS_TONE[data.status] ?? 'secondary'}>{data.status}</ToneBadge>
          </div>
          <CardDescription>
            template v{data.templateVersion} · started {formatDateTime(data.startedAt)}
            {data.finishedAt && ` · finished ${formatDateTime(data.finishedAt)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          {Object.keys(data.inputs).length > 0 && (
            <pre className='bg-muted overflow-x-auto rounded-md p-2 text-xs'>
              {JSON.stringify(data.inputs, null, 2)}
            </pre>
          )}
          <div className='flex flex-wrap gap-2'>
            {canResume && (
              <Button
                size='sm'
                disabled={resumeMutation.isPending}
                onClick={() => resumeMutation.mutate()}
              >
                <Icons.arrowRight />
                Resume run
              </Button>
            )}
            {canAbandon && (
              <Button
                size='sm'
                variant='outline'
                disabled={abandonMutation.isPending}
                onClick={() => abandonMutation.mutate()}
              >
                <Icons.xCircle />
                Abandon run
              </Button>
            )}
          </div>
          {canAbandon && (
            <p className='text-muted-foreground text-xs'>
              Abandoning does not undo anything — every step this run already completed stays
              exactly as it is. There is no rollback.
            </p>
          )}
        </CardContent>
      </Card>

      <TemplateRunStepsList steps={data.steps} />
    </div>
  );
}

function RunDetail() {
  const { id } = Route.useParams();
  return (
    <InfrastructurePage
      title='Template run'
      description='The step ladder, with resume and abandon.'
    >
      <React.Suspense fallback={<DetailSkeleton />}>
        <RunDetailData id={id} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function RunDetailError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage
      title='Template run'
      description='The step ladder, with resume and abandon.'
    >
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
