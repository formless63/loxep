import * as React from 'react';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import DnsDriftPanel from '@/features/infrastructure/components/dns-drift-panel';
import MailPanel from '@/features/infrastructure/components/mail-panel';
import ProxyChainPanel from '@/features/infrastructure/components/proxy-chain-panel';
import { managedDomainQuery } from '@/features/infrastructure/api/queries';
import {
  MANAGED_DOMAIN_STATE_LABELS,
  MANAGED_DOMAIN_STATE_TONE
} from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { requestDomainResync } from '@/server/infrastructure-functions';
import type { ManagedDomainDetailDto } from '@/server/infrastructure-functions';

export const Route = createFileRoute('/infrastructure/domains/$name')({
  loader: async ({ context: { queryClient }, params }) => {
    await queryClient.ensureQueryData(managedDomainQuery(params.name));
  },
  errorComponent: DomainDetailError,
  component: DomainDetail
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

function DomainSummaryCard({ domain }: { domain: ManagedDomainDetailDto }) {
  const queryClient = useQueryClient();
  const resyncMutation = useMutation({
    mutationFn: () => requestDomainResync({ data: { domainId: domain.id } }),
    onSuccess: async () => {
      toast.success('Sync enqueued');
      await queryClient.invalidateQueries({ queryKey: managedDomainQuery(domain.name).queryKey });
    },
    onError: (error) => toastError(error, 'Failed to enqueue a sync')
  });

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center gap-2'>
          <CardTitle className='text-base'>Provisioning</CardTitle>
          <ToneBadge tone={MANAGED_DOMAIN_STATE_TONE[domain.state] ?? 'secondary'}>
            {MANAGED_DOMAIN_STATE_LABELS[domain.state] ?? domain.state}
          </ToneBadge>
          {domain.driftDetectedAt && (
            <Badge variant='destructive'>
              <Icons.alertCircle />
              drifted
            </Badge>
          )}
        </div>
        <CardDescription>
          {domain.apexTargetName
            ? `Points at ${domain.apexTargetName}`
            : 'DNS only — no hosting target'}
          {domain.lastReconciledAt &&
            ` · last reconciled ${formatDateTime(domain.lastReconciledAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {domain.zoneNameservers && domain.zoneNameservers.length > 0 && (
          <div>
            <p className='text-sm font-medium'>Nameservers to set at the registrar</p>
            <ul className='text-muted-foreground font-mono text-sm'>
              {domain.zoneNameservers.map((ns) => (
                <li key={ns}>{ns}</li>
              ))}
            </ul>
          </div>
        )}
        {domain.lastErrorCode && (
          <Alert variant='destructive'>
            <AlertTitle>Last error: {domain.lastErrorCode}</AlertTitle>
            <AlertDescription>
              {domain.lastErrorAt && `At ${formatDateTime(domain.lastErrorAt)}.`} The next sweep
              retries automatically.
            </AlertDescription>
          </Alert>
        )}
        <div>
          <p className='text-sm font-medium'>Desired records ({domain.records.length})</p>
          {domain.records.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No desired records yet.</p>
          ) : (
            <ul className='mt-1 flex flex-col gap-1'>
              {domain.records.map((record) => (
                <li key={record.id} className='font-mono text-sm'>
                  <Badge variant='outline' className='mr-2'>
                    {record.type}
                  </Badge>
                  {record.name} → {record.content}
                  {record.proxied && <span className='text-muted-foreground'> (proxied)</span>}
                  <span className='text-muted-foreground'> · {record.owner}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <Button
            size='sm'
            variant='outline'
            disabled={resyncMutation.isPending}
            onClick={() => resyncMutation.mutate()}
          >
            Sync now
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function DomainDetailData({ name }: { name: string }) {
  const { data } = useSuspenseQuery(managedDomainQuery(name));
  return (
    <div className='flex flex-col gap-4'>
      <DomainSummaryCard domain={data} />
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2'>
        <DnsDriftPanel domainId={data.id} domainName={data.name} findings={data.unresolvedDrift} />
        <MailPanel
          domainId={data.id}
          domainName={data.name}
          mailEnabled={data.mailEnabled}
          mail={data.mail}
          mailboxes={data.mailboxes}
        />
      </div>
      {/* loxep-acj.2 (Pangolin chain design M2): the chain's third link —
          domain -> Cloudflare record (above, in "Desired records") ->
          Pangolin resource -> hosting target. Read-only; check-mode only. */}
      <ProxyChainPanel resources={data.proxyResources} />
    </div>
  );
}

function DomainDetail() {
  const { name } = Route.useParams();
  return (
    <InfrastructurePage title={name} description='Delegation, DNS diff, mail, and hosting.'>
      <React.Suspense fallback={<DetailSkeleton />}>
        <DomainDetailData name={name} />
      </React.Suspense>
    </InfrastructurePage>
  );
}

function DomainDetailError({ error }: ErrorComponentProps) {
  const router = useRouter();
  const { name } = Route.useParams();
  return (
    <InfrastructurePage title={name} description='Delegation, DNS diff, mail, and hosting.'>
      <Alert variant='destructive'>
        <AlertTitle>Domain unavailable</AlertTitle>
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
