import { useQuery } from '@tanstack/react-query';
import { EstateSection } from '@/features/estate/components/estate-section';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { beszelEstateHubQuery } from '@/features/infrastructure/api/queries';

/**
 * The Beszel estate's HUB section (Estate Browsers Design §3.5) —
 * `health()`, unauthenticated, rendered verbatim (Rule P3): PocketBase's own
 * `reachable`/`httpStatus`/`message`, never a Loxep-coined verdict word.
 */
export default function BeszelHubPanel({ connectionId }: { connectionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(beszelEstateHubQuery(connectionId));

  return (
    <EstateSection
      title='Hub'
      description="Live from Beszel's health() — unauthenticated."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={() => false}
      emptyMessage=''
    >
      {(hub) => (
        <div className='flex flex-wrap items-center gap-3'>
          <ToneBadge tone={hub.reachable ? 'success' : 'destructive'}>
            {hub.reachable ? 'reachable' : 'unreachable'}
          </ToneBadge>
          <span className='text-muted-foreground text-sm'>HTTP {hub.httpStatus}</span>
          {hub.message !== null && (
            <span className='text-muted-foreground text-sm'>{hub.message}</span>
          )}
        </div>
      )}
    </EstateSection>
  );
}
