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
import { CONTROL_SURFACE_LABELS } from '@/features/infrastructure/constants';
import {
  hostingTargetOptionsQuery,
  hostingTargetsQuery,
  unmatchedTailscaleDevicesQuery
} from '@/features/infrastructure/api/queries';
import { attachDiscoveredFleetResource } from '@/server/infrastructure-functions';
import type { UnmatchedTailscaleDeviceDto } from '@/server/infrastructure-functions';

/**
 * The candidates panel's "link" action (loxep-50t §4 item 1) — the SAME
 * attach flow `AttachDiscoveredResourceDialog` uses
 * (`attachDiscoveredFleetResource`, idempotent on
 * `resource_links_resource_purpose_uq`, purpose resolved server-side from
 * the fixed fleet-tool vocabulary — never client-supplied), entered from the
 * opposite direction: that dialog fixes the HOST and lets the operator pick
 * a discovered resource; this one fixes the DEVICE (already chosen from the
 * candidates panel) and lets the operator pick the host.
 *
 * No ranking/suggestion is built here. The design's §1.1 scoring ("a ranked,
 * operator-confirmed suggestion is permitted, automatic matching is not") is
 * explicitly a MAY for a candidate-preselection nicety, not a requirement of
 * this slice — every hosting target is listed, alphabetical order from
 * `fetchHostingTargetOptions`, fully operator-confirmed either way.
 */
export default function LinkDeviceDialog({
  open,
  onOpenChange,
  device
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device: UnmatchedTailscaleDeviceDto;
}) {
  const queryClient = useQueryClient();
  const { data: targets, isLoading } = useQuery(hostingTargetOptionsQuery);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (hostingTargetId: string) =>
      attachDiscoveredFleetResource({
        data: { hostingTargetId, externalResourceId: device.id }
      }),
    onSuccess: async () => {
      toast.success('Device linked');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: hostingTargetsQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: unmatchedTailscaleDevicesQuery.queryKey })
      ]);
      close(false);
    },
    onError: (error) => toastError(error, 'Failed to link device')
  });

  function close(next: boolean) {
    if (!next) setSelectedId(null);
    onOpenChange(next);
  }

  const deviceLabel = device.title ?? device.magicDnsName ?? device.externalId ?? 'this device';

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>Link {deviceLabel} to a hosting target</DialogTitle>
          <DialogDescription>
            Pick the existing hosting target this tailnet device actually is. Loxep never guesses
            this from a name.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <p className='text-muted-foreground text-sm'>Loading…</p>
        ) : targets === undefined || targets.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.integrations />
              </EmptyMedia>
              <EmptyTitle>No hosting targets yet</EmptyTitle>
              <EmptyDescription>Declare this device as a hosting target instead.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <RadioGroup value={selectedId ?? undefined} onValueChange={setSelectedId}>
            {targets.map((target) => (
              <label
                key={target.id}
                htmlFor={`link-target-${target.id}`}
                className='hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2'
              >
                <RadioGroupItem value={target.id} id={`link-target-${target.id}`} />
                <span className='flex min-w-0 flex-1 flex-col'>
                  <span className='font-medium'>{target.name}</span>
                  <span className='text-muted-foreground text-sm'>
                    {CONTROL_SURFACE_LABELS[target.controlSurface] ?? target.controlSurface}
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
            Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
