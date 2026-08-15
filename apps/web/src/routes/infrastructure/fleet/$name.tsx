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
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { InfrastructurePage } from '@/features/infrastructure/components/infrastructure-page';
import CompanionLinksPanel from '@/features/infrastructure/components/companion-links-panel';
import DockhandContainersPanel from '@/features/infrastructure/components/dockhand-containers-panel';
import HostingTargetTokensPanel from '@/features/infrastructure/components/hosting-target-tokens-panel';
import { hostingTargetQuery, hostingTargetsQuery } from '@/features/infrastructure/api/queries';
import { CONTROL_SURFACE_LABELS } from '@/features/infrastructure/constants';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { decommissionHostingTarget } from '@/server/infrastructure-functions';
import type {
  HostingTargetDetailDto,
  PrivateNetworkRowDto
} from '@/server/infrastructure-functions';

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

/**
 * Warns when the stored `addressV4`/`addressV6` itself falls inside
 * Tailscale's CGNAT or ULA range (loxep-89h; loxep-50t §3.2). This is a
 * DISPLAY-only warning about data already stored — it never reads, offers,
 * or pre-fills anything from a Tailscale device, which stays forbidden by
 * the same design. The classification comes from the server, computed with
 * the same predicate `resolveHostingAddress` refuses on
 * (`addressV4TailnetKind`/`addressV6TailnetKind` on the DTO), so this
 * component never needs its own copy of the CGNAT/ULA prefixes.
 */
function TailnetAddressWarning({ target }: { target: HostingTargetDetailDto }) {
  const badAddresses = [
    target.addressV4TailnetKind !== null ? target.addressV4 : null,
    target.addressV6TailnetKind !== null ? target.addressV6 : null
  ].filter((value): value is string => value !== null);

  if (badAddresses.length === 0) return null;

  return (
    <Alert variant='warning'>
      <Icons.warning />
      <AlertTitle>This address cannot be published</AlertTitle>
      <AlertDescription>
        <span>
          {badAddresses.join(' and ')} {badAddresses.length > 1 ? 'are' : 'is'} a private Tailscale
          address — a tailnet address only answers for devices on that tailnet, never for a public
          name. DNS materialization for any domain pointed at this target will refuse rather than
          publish it.
        </span>
        <span>
          Replace it with a publicly routable address, or clear the field if this target has none.
        </span>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The fleet-detail "Private network" row (loxep-50t §1.2) — rendered
 * directly under the address line, ONLY when this target carries a
 * `tailscale`/`private_network` link. Every field is server-computed
 * (`computePrivateNetworkRow` in `infrastructure-functions.ts`); this
 * component only formats it.
 */
function PrivateNetworkRow({ row }: { row: PrivateNetworkRowDto }) {
  return (
    <div className='flex flex-col gap-1 rounded-md border px-3 py-2'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-sm font-medium'>Private network</span>
        <span className='text-sm tabular-nums'>{row.addresses.join(' · ') || 'No address'}</span>
        {row.online === true ? (
          <Badge variant='success'>online</Badge>
        ) : row.online === false ? (
          <Badge variant='outline'>
            {row.lastSeen ? `last seen ${formatRelativeTime(row.lastSeen)}` : 'offline'}
          </Badge>
        ) : null}
        {row.authorized === false && <Badge variant='warning'>unauthorized device</Badge>}
        <span
          className='text-muted-foreground text-xs'
          title={row.checkedAt ? formatDateTime(row.checkedAt) : undefined}
        >
          {row.checkedAt ? `as of ${formatRelativeTime(row.checkedAt)}` : 'not yet checked'}
        </span>
      </div>
      <p className='text-muted-foreground text-sm'>
        linked device{row.magicDnsName && ` "${row.magicDnsName}"`}
        {row.os && ` · ${row.os}`}
        {' · '}
        <a href={row.url} target='_blank' rel='noreferrer' className='underline'>
          open in Tailscale
        </a>
      </p>
      {row.reachabilityCaveat && (
        <Alert>
          <Icons.info />
          <AlertDescription>{row.reachabilityCaveat}</AlertDescription>
        </Alert>
      )}
    </div>
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
          {data.privateNetwork && <PrivateNetworkRow row={data.privateNetwork} />}
          <TailnetAddressWarning target={data} />
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
        <CompanionLinksPanel
          hostingTargetId={data.id}
          hostingTargetName={data.name}
          links={data.companionLinks}
          diagnosis={data.diagnosis}
        />
      </div>

      {/* loxep-hb7 Milestone B: the one dedicated tool-specific panel the
          anti-soup rule licenses — mounted ONLY when a dockhand/environment
          link exists, per hb7 §3.2 rule 3 ("absent, not green, not empty"). */}
      {data.companionLinks.some(
        (link) => link.provider === 'dockhand' && link.externalType === 'environment'
      ) && <DockhandContainersPanel hostingTargetId={data.id} />}
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
