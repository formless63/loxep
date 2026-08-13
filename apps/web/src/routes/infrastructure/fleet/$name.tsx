import * as React from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/lib/errors';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import CompanionLinksPanel from '@/features/infrastructure/components/companion-links-panel';
import HostingTargetTokensPanel from '@/features/infrastructure/components/hosting-target-tokens-panel';
import { hostingTargetQuery, hostingTargetsQuery } from '@/features/infrastructure/api/queries';
import { CONTROL_SURFACE_LABELS } from '@/features/infrastructure/constants';
import { decommissionHostingTarget } from '@/server/infrastructure-functions';
import type { HostingTargetDetailDto } from '@/server/infrastructure-functions';

export const Route = createFileRoute('/infrastructure/fleet/$name')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(hostingTargetQuery(params.name));
  },
  errorComponent: FleetDetailError,
  component: FleetDetail
});

function DetailSkeleton() {
  return (
    <div className='flex flex-col gap-4'>
      <Skeleton className='h-32 w-full' />
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <Skeleton className='h-64 w-full' />
        <Skeleton className='h-64 w-full' />
      </div>
    </div>
  );
}

function DecommissionButton({ target }: { target: HostingTargetDetailDto }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);

  const mutation = useMutation({
    mutationFn: () => decommissionHostingTarget({ data: { id: target.id } }),
    onSuccess: async () => {
      toast.success('Hosting target decommissioned');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: hostingTargetQuery(target.name).queryKey }),
        queryClient.invalidateQueries({ queryKey: hostingTargetsQuery.queryKey })
      ]);
    },
    onError: (error) => toastError(error, 'Failed to decommission'),
    onSettled: () => setConfirming(false)
  });

  if (target.decommissionedAt !== null) {
    return <Badge variant='secondary'>Decommissioned</Badge>;
  }

  return (
    <>
      <Button size='sm' variant='destructive' onClick={() => setConfirming(true)}>
        Decommission
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Decommission "{target.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Retires the target without deleting it — history is kept. Domains still pointing at it
              will need a new target before their records materialize correctly again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={mutation.isPending} onClick={() => mutation.mutate()}>
              Decommission
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function FleetDetailData({ name }: { name: string }) {
  const { data } = useSuspenseQuery(hostingTargetQuery(name));
  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <div className='flex flex-wrap items-center gap-2'>
            <CardTitle className='text-base'>
              {CONTROL_SURFACE_LABELS[data.controlSurface] ?? data.controlSurface}
            </CardTitle>
            <DecommissionButton target={data} />
          </div>
          <CardDescription>
            {data.addressV4 ?? data.addressV6 ?? 'No address'}
            {data.frontedByTargetName && ` · fronted by ${data.frontedByTargetName}`}
            {data.provider && ` · ${data.provider}`}
            {data.region && ` (${data.region})`}
          </CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-3'>
          <div>
            <p className='text-sm font-medium'>Domains pointing here ({data.domains.length})</p>
            {data.domains.length === 0 ? (
              <p className='text-muted-foreground text-sm'>None yet.</p>
            ) : (
              <ul className='mt-1 flex flex-col gap-1'>
                {data.domains.map((domain) => (
                  <li key={domain.id}>
                    <Link
                      to='/infrastructure/domains/$name'
                      params={{ name: domain.name }}
                      className='outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
                    >
                      {domain.name}
                    </Link>
                    <span className='text-muted-foreground'> · {domain.state}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {data.frontedTargets.length > 0 && (
            <div>
              <p className='text-sm font-medium'>Fronts ({data.frontedTargets.length})</p>
              <ul className='mt-1 flex flex-col gap-1'>
                {data.frontedTargets.map((fronted) => (
                  <li key={fronted.id}>
                    <Link
                      to='/infrastructure/fleet/$name'
                      params={{ name: fronted.name }}
                      className='outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring'
                    >
                      {fronted.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <HostingTargetTokensPanel
          hostingTargetId={data.id}
          hostingTargetName={data.name}
          tokens={data.tokens}
        />
        <CompanionLinksPanel links={data.companionLinks} />
      </div>
    </div>
  );
}

function FleetDetail() {
  const { name } = Route.useParams();
  return (
    <InfrastructurePage title={name} description='Domains, token scope, and control surface.'>
      <React.Suspense fallback={<DetailSkeleton />}>
        <FleetDetailData name={name} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function FleetDetailError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const { name } = Route.useParams();
  return (
    <InfrastructurePage title={name} description='Domains, token scope, and control surface.'>
      <Alert variant='destructive'>
        <AlertTitle>Hosting target unavailable</AlertTitle>
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
