import * as React from 'react';
import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
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
import { formatDateTime } from '@/lib/format';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import TemplateStepsList from '@/features/infrastructure/components/template-steps-list';
import { provisioningTemplateQuery } from '@/features/infrastructure/api/queries';
import { RUN_STATUS_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { ProvisioningTemplateDetailDto } from '@/server/provisioning-functions';

export const Route = createFileRoute('/infrastructure/templates/$id/')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(provisioningTemplateQuery(params.id));
  },
  errorComponent: TemplateDetailError,
  component: TemplateDetail
});

function DetailSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-24 w-full' />
      <Skeleton className='h-96 w-full' />
    </div>
  );
}

function TemplateDetailData({ id }: { id: string }) {
  const { data } = useSuspenseQuery(provisioningTemplateQuery(id));

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <div className='flex flex-wrap items-center gap-2'>
            <CardTitle className='text-base'>{data.name}</CardTitle>
            <Badge variant='outline'>v{data.version}</Badge>
            {data.isDefault && <Badge variant='secondary'>Default</Badge>}
          </div>
          {data.description && <CardDescription>{data.description}</CardDescription>}
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to='/infrastructure/templates/$id/run' params={{ id: data.id }}>
              <Icons.arrowRight />
              Run template
            </Link>
          </Button>
        </CardContent>
      </Card>

      <div>
        <h2 className='mb-2 text-lg font-semibold'>Steps</h2>
        <TemplateStepsList steps={data.steps} />
      </div>

      <RunHistory data={data} />
    </div>
  );
}

function RunHistory({ data }: { data: ProvisioningTemplateDetailDto }) {
  if (data.runs.length === 0) {
    return (
      <div>
        <h2 className='mb-2 text-lg font-semibold'>Runs</h2>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.clock />
            </EmptyMedia>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>Start a run to provision against this template.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div>
      <h2 className='mb-2 text-lg font-semibold'>Runs</h2>
      <ol className='flex flex-col gap-2'>
        {data.runs.map((run) => (
          <li key={run.id}>
            <Link
              to='/infrastructure/templates/runs/$id'
              params={{ id: run.id }}
              className='outline-none'
            >
              <Card className='hover:bg-accent/50 transition-colors'>
                <CardContent className='flex flex-wrap items-center gap-2 py-3'>
                  <ToneBadge tone={RUN_STATUS_TONE[run.status] ?? 'secondary'}>
                    {run.status}
                  </ToneBadge>
                  <span className='text-muted-foreground text-sm'>
                    started {formatDateTime(run.startedAt)}
                  </span>
                  {run.finishedAt && (
                    <span className='text-muted-foreground text-sm'>
                      · finished {formatDateTime(run.finishedAt)}
                    </span>
                  )}
                </CardContent>
              </Card>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TemplateDetail() {
  const { id } = Route.useParams();
  return (
    <InfrastructurePage
      title='Provisioning template'
      description='The step ladder, and run history.'
    >
      <React.Suspense fallback={<DetailSkeleton />}>
        <TemplateDetailData id={id} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function TemplateDetailError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage
      title='Provisioning template'
      description='The step ladder, and run history.'
    >
      <Alert variant='destructive'>
        <AlertTitle>Template unavailable</AlertTitle>
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
