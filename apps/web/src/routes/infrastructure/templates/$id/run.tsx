import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import TemplateRunWizardForm from '@/features/infrastructure/components/template-run-wizard-form';
import { provisioningTemplateQuery } from '@/features/infrastructure/api/queries';

export const Route = createFileRoute('/infrastructure/templates/$id/run')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(provisioningTemplateQuery(params.id));
  },
  errorComponent: RunWizardError,
  component: RunWizard
});

function WizardData({ id }: { id: string }) {
  const { data } = useSuspenseQuery(provisioningTemplateQuery(id));
  return <TemplateRunWizardForm template={data} />;
}

function RunWizard() {
  const { id } = Route.useParams();
  return (
    <InfrastructurePage
      title='Run template'
      description='Answer its inputs, preview the compiled plan, then start — the run writes intent and enqueues; it never awaits a provider call.'
    >
      <React.Suspense fallback={<Skeleton className='h-96 max-w-3xl' />}>
        <WizardData id={id} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function RunWizardError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <InfrastructurePage title='Run template' description='Answer its inputs, then start.'>
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
