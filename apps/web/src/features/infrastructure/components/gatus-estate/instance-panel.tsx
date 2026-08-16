import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { EstateSection } from '@/features/estate/components/estate-section';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { gatusEstateInstanceQuery } from '@/features/infrastructure/api/queries';
import type { GatusEstatePosture } from '@/server/gatus-estate-functions';

/**
 * Copy-only labels for the design's own three-way posture inference — never
 * a security decision, only what the badge SAYS (`gatus-estate-functions.ts`'s
 * own doc, quoting `@loxep/integration-gatus`'s module doc verbatim on this
 * point).
 */
const POSTURE_LABEL: Record<GatusEstatePosture, string> = {
  open: 'Open — no security configured',
  basic: 'Basic auth configured',
  oidc: 'OIDC-secured'
};

/**
 * The Gatus estate's INSTANCE section (Estate Browsers Design §3.7) —
 * `probeConfig()` + `health()`, both unauthenticated, two calls. Renders the
 * recovered three-way posture and links to the `GatusPushCard`
 * (`/settings/application`) rather than merging Loxep's OWN heartbeat into
 * this read — loxep-1au binding rule 2 keeps "our read of them" and "their
 * opinion of us" in separate fields permanently.
 */
export default function GatusInstancePanel({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(
    gatusEstateInstanceQuery(connectionId)
  );

  return (
    <EstateSection
      title='Instance'
      description="Live from Gatus's probeConfig() and health() — both unauthenticated."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={() => false}
      emptyMessage=''
    >
      {(instance) => (
        <div className='flex flex-col gap-3'>
          <div className='flex flex-wrap items-center gap-3'>
            <ToneBadge tone={instance.posture === 'oidc' ? 'warning' : 'outline'}>
              {POSTURE_LABEL[instance.posture]}
            </ToneBadge>
            <ToneBadge tone={instance.health.reachable ? 'success' : 'destructive'}>
              {instance.health.reachable ? 'reachable' : 'unreachable'}
            </ToneBadge>
            {instance.health.status !== null && (
              <span className='text-muted-foreground text-sm'>{instance.health.status}</span>
            )}
            <span className='text-muted-foreground text-sm'>HTTP {instance.health.httpStatus}</span>
          </div>
          {instance.posture === 'oidc' && (
            <p className='text-muted-foreground text-sm'>
              A server-to-server reader cannot authenticate against the bulk endpoint-statuses read
              on an OIDC-secured Gatus — the Endpoints section below shows why, and each
              endpoint&apos;s uptime drill-in still works.
            </p>
          )}
          <p className='text-muted-foreground text-sm'>
            This is Loxep&apos;s read OF Gatus. Loxep&apos;s own outward heartbeat — Gatus&apos;s
            opinion of Loxep — is configured separately and never merged here.{' '}
            <Button variant='link' className='h-auto p-0' asChild>
              <Link to='/settings/application'>Open push settings</Link>
            </Button>
          </p>
        </div>
      )}
    </EstateSection>
  );
}
