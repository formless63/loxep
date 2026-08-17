import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toastError } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/format';
import {
  discoveredFleetResourcesQuery,
  hostingTargetsQuery,
  infrastructureOverviewQuery
} from '@/features/infrastructure/api/queries';
import { adoptContainerHostAsHostingTarget } from '@/server/infrastructure-functions';

/**
 * "Dockhand manages N hosts Loxep does not know about" (hb7 §2.6) — the
 * installation-wide surface for `ContainerHostPlan.unmatchedObserved`, the
 * failure mode hb7 explicitly warns must not stay computation-only. Reads
 * `listUnattachedByProvider('dockhand')` — the SAME discovery-populated
 * candidate set the attach picker already offers (`fetchDiscoveredFleetResources`)
 * — rather than re-deriving it from a per-target reconcile run's own diff:
 * one target's `unmatchedObserved` counts every OTHER declared target's own
 * host too (the planner compares ONE desired host against the whole
 * connection's inventory), so the deduplicated, connection-wide discovery
 * set is the cheaper and more accurate source for this aggregate view. The
 * per-target panel (`ContainerHostRegistrationPanel`) is where the raw
 * planner output is exercised instead.
 *
 * "Adopt" NEVER auto-creates — an explicit, per-row, named action (hb7
 * §2.6/§3.2's "never automatic"). Absent entirely, not an empty state, when
 * nothing is unmatched — this is a punch list, not a status row.
 */
export default function UnmatchedContainerHostsCard() {
  const queryClient = useQueryClient();
  const { data: candidates } = useQuery(discoveredFleetResourcesQuery('dockhand'));

  const adoptMutation = useMutation({
    mutationFn: (externalResourceId: string) =>
      adoptContainerHostAsHostingTarget({ data: { externalResourceId } }),
    onSuccess: async (result) => {
      toast.success(`Adopted as hosting target "${result.name}"`);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: discoveredFleetResourcesQuery('dockhand').queryKey
        }),
        queryClient.invalidateQueries({ queryKey: hostingTargetsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: infrastructureOverviewQuery.queryKey })
      ]);
    },
    onError: (error) => toastError(error, 'Failed to adopt this host')
  });

  const unmatched = candidates ?? [];
  if (unmatched.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Observed Dockhand hosts</CardTitle>
        <CardDescription>
          Registered at Dockhand, not yet attached to a hosting target — adopt one to start managing
          it from Loxep.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className='flex flex-col gap-2'>
          {unmatched.map((candidate) => (
            <li
              key={candidate.id}
              className='flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2'
            >
              <div className='flex flex-col'>
                <span className='font-medium'>
                  {candidate.title ?? candidate.externalId ?? 'Untitled'}
                </span>
                <span className='text-muted-foreground text-xs'>
                  {candidate.host && `${candidate.host} · `}
                  {candidate.observedAt
                    ? `observed ${formatRelativeTime(candidate.observedAt)}`
                    : 'never observed'}
                </span>
              </div>
              <Button
                size='sm'
                variant='outline'
                disabled={adoptMutation.isPending}
                onClick={() => adoptMutation.mutate(candidate.id)}
              >
                Adopt as hosting target
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
