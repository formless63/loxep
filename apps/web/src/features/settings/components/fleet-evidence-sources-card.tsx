import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { toastError } from '@/lib/errors';
import { fleetEvidenceSourcesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import NewFleetEvidenceSourceDialog from '@/features/settings/components/new-fleet-evidence-source-dialog';
import { deleteConnection } from '@/server/admin-functions';

const PROVIDER_LABELS: Record<string, string> = {
  gatus: 'Gatus',
  beszel: 'Beszel',
  databasus: 'Databasus',
  generic: 'Generic'
};

/**
 * `/settings/connections`' fleet-evidence-source panel (Phase 8 milestone 7,
 * loxep-ovj.7) — configures the inbound `POST /api/v1/hooks/fleet/
 * :connectionId` webhook Loxep's fleet tools can post alert/backup-status
 * evidence to. Deliberately NOT the donor `DataTable` stack: an
 * installation configures a handful of these (one per companion tool that
 * gets a webhook pasted into it), the same "small, enumerated config list"
 * shape `GatusPushCard` already renders as a plain card rather than a data
 * table.
 *
 * Recording is not delivering: this panel's copy repeats the design's own
 * rule wherever an operator might otherwise assume pasting a URL here makes
 * Loxep the alert path (it never is — see `NewFleetEvidenceSourceDialog`).
 */
export default function FleetEvidenceSourcesCard({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(fleetEvidenceSourcesQuery);

  const removeMutation = useMutation({
    mutationFn: (connectionId: string) => deleteConnection({ data: { id: connectionId } }),
    onSuccess: async (result) => {
      if (!result.deleted) {
        toast.error('This evidence source has recorded history and cannot be removed.');
        return;
      }
      toast.success('Evidence source removed.');
      await queryClient.invalidateQueries({ queryKey: fleetEvidenceSourcesQuery.queryKey });
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to remove evidence source')
  });

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-4'>
        <div>
          <CardTitle className='text-base'>Inbound fleet evidence</CardTitle>
          <CardDescription>
            Gatus, Beszel, and backup tools like Databasus can POST alert or backup-status evidence
            to a per-source webhook. Loxep records it and rolls it into integration health — it
            never delivers the alert itself; the sending tool must still notify its own operator
            directly.
          </CardDescription>
        </div>
        {isAdmin && <NewFleetEvidenceSourceDialog />}
      </CardHeader>
      <CardContent>
        {isPending && <p className='text-muted-foreground text-sm'>Loading…</p>}
        {isError && (
          <QueryErrorAlert
            error={error}
            title='Failed to load evidence sources'
            onRetry={() => refetch()}
          />
        )}
        {!isPending && !isError && data.length === 0 && (
          <p className='text-muted-foreground text-sm'>
            No inbound evidence sources configured yet.
          </p>
        )}
        {!isPending && !isError && data.length > 0 && (
          <ul className='divide-y'>
            {data.map((source) => (
              <li
                key={source.connectionId}
                className='flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0'
              >
                <div className='flex items-center gap-2'>
                  <span className='font-medium'>{source.name}</span>
                  <Badge variant='secondary'>
                    {PROVIDER_LABELS[source.provider] ?? source.provider}
                  </Badge>
                  {!source.hasToken && <Badge variant='destructive'>No token minted</Badge>}
                </div>
                {isAdmin && (
                  <Button
                    variant='ghost'
                    size='sm'
                    onClick={() => removeMutation.mutate(source.connectionId)}
                    disabled={removeMutation.isPending}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
