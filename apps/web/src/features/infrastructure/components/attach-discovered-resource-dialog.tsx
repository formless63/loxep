import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/format';
import {
  discoveredFleetResourcesQuery,
  hostingTargetQuery
} from '@/features/infrastructure/api/queries';
import { attachDiscoveredFleetResource } from '@/server/infrastructure-functions';

/**
 * The operator-confirmed attach picker (loxep-y64 slice 3).
 *
 * A discovery sweep (today: only Beszel's — `@loxep/app`'s
 * `projectBeszelSystems`, run as a side effect of the connection health
 * probe) upserts one `external_resources` row per observed system, whether
 * or not it is attached to anything. This dialog lists exactly one
 * PROVIDER's unattached rows (`fetchDiscoveredFleetResources`) and requires
 * the operator to pick one before anything is written —
 * `attachDiscoveredFleetResource` resolves the link purpose itself from the
 * design's fixed vocabulary, so the picker cannot invent one.
 *
 * **Never a name join.** Nothing here pre-selects a candidate, ranks by
 * string similarity to `hostingTargetName`, or attaches without this
 * explicit click — the design's rule for every non-Dockhand fleet adapter
 * (`name` is one of Beszel's own UNVERIFIED fields; a wrong automatic match
 * would mislabel a host's status silently, with nothing to review). Every
 * candidate's `host`/`status`/`observedAt` are shown as HINTS only, read
 * straight from the resource's own sync `metadata` — never a live read on
 * open.
 *
 * Reusable: pass a different `provider`/`providerLabel` once Dockhand/Gatus/
 * Tailscale/Termix grow their own discovery side effects — nothing else here
 * is Beszel-specific.
 */
export default function AttachDiscoveredResourceDialog({
  open,
  onOpenChange,
  hostingTargetId,
  hostingTargetName,
  provider,
  providerLabel
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostingTargetId: string;
  hostingTargetName: string;
  provider: string;
  providerLabel: string;
}) {
  const queryClient = useQueryClient();
  const { data: candidates, isLoading } = useQuery(discoveredFleetResourcesQuery(provider));
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (externalResourceId: string) =>
      attachDiscoveredFleetResource({ data: { hostingTargetId, externalResourceId } }),
    onSuccess: async () => {
      toast.success(`${providerLabel} system attached`);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: hostingTargetQuery(hostingTargetName).queryKey
        }),
        queryClient.invalidateQueries({
          queryKey: discoveredFleetResourcesQuery(provider).queryKey
        })
      ]);
      close(false);
    },
    onError: (error) => toastError(error, `Failed to attach ${providerLabel} system`)
  });

  function close(next: boolean) {
    if (!next) setSelectedId(null);
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>Attach a discovered {providerLabel} system</DialogTitle>
          <DialogDescription>
            Loxep discovered these during its last sweep but has not linked any of them to a host.
            Pick the one that is actually {hostingTargetName} — Loxep never guesses this from a
            name.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className='text-muted-foreground text-sm'>Loading…</p>
        ) : candidates === undefined || candidates.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.radar />
              </EmptyMedia>
              <EmptyTitle>No discovered {providerLabel} systems</EmptyTitle>
              <EmptyDescription>
                Either Loxep has not swept a {providerLabel} connection yet, or every discovered
                system is already attached elsewhere.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <RadioGroup value={selectedId ?? undefined} onValueChange={setSelectedId}>
            {candidates.map((candidate) => (
              <label
                key={candidate.id}
                htmlFor={`discovered-resource-${candidate.id}`}
                className='hover:bg-accent/50 flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2'
              >
                <RadioGroupItem
                  value={candidate.id}
                  id={`discovered-resource-${candidate.id}`}
                  className='mt-1'
                />
                <span className='flex min-w-0 flex-1 flex-col'>
                  <span className='font-medium'>
                    {candidate.title ?? candidate.externalId ?? candidate.id}
                  </span>
                  <span className='text-muted-foreground text-sm'>
                    {candidate.host ?? 'host unverified'}
                    {candidate.status !== null && ` · reports "${candidate.status}"`}
                    {candidate.observedAt !== null &&
                      ` · updated ${formatRelativeTime(candidate.observedAt)}`}
                  </span>
                </span>
              </label>
            ))}
          </RadioGroup>
        )}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            type='button'
            disabled={selectedId === null || mutation.isPending}
            onClick={() => selectedId !== null && mutation.mutate(selectedId)}
          >
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
