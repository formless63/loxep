import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
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
import { hostingTargetOptionsQuery } from '@/features/infrastructure/api/queries';
import { attachDiscoveredFleetResource } from '@/server/infrastructure-functions';
import type { BeszelEstateSystemDto } from '@/server/beszel-estate-functions';

/**
 * The Beszel estate's ATTACH action (Estate Browsers Design §3.5: "the
 * page's one verb is ATTACH, mounting the existing operator-confirmed
 * `AttachDiscoveredResourceDialog`"). The shipped dialog fixes the HOST and
 * lets the operator pick a discovered system; this page's rows are SYSTEMS,
 * so this component is the SAME `attachDiscoveredFleetResource` write,
 * entered from the opposite direction — exactly the precedent
 * `LinkDeviceDialog` already established for the Tailscale estate page
 * (`unmatched-devices-panel/link-device-dialog.tsx`'s own doc: "the SAME
 * attach flow… entered from the opposite direction"). No new write path, no
 * new payload shape (Rule P10) — only the picker direction differs.
 */
export default function AttachBeszelSystemDialog({
  open,
  onOpenChange,
  system
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  system: BeszelEstateSystemDto;
}) {
  const queryClient = useQueryClient();
  const { data: targets, isLoading } = useQuery(hostingTargetOptionsQuery);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (hostingTargetId: string) =>
      attachDiscoveredFleetResource({
        data: { hostingTargetId, externalResourceId: system.externalResourceId as string }
      }),
    onSuccess: async () => {
      toast.success('Beszel system attached');
      await queryClient.invalidateQueries();
      close(false);
    },
    onError: (error) => toastError(error, 'Failed to attach Beszel system')
  });

  function close(next: boolean) {
    if (!next) setSelectedId(null);
    onOpenChange(next);
  }

  const systemLabel = system.name ?? system.host ?? system.externalSystemId;

  return (
    <ResponsiveDialog open={open} onOpenChange={close}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Attach {systemLabel} to a hosting target</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Pick the existing hosting target this Beszel system actually is. Loxep never guesses
            this from a name.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {isLoading ? (
          <p className='text-muted-foreground text-sm'>Loading…</p>
        ) : targets === undefined || targets.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.integrations />
              </EmptyMedia>
              <EmptyTitle>No hosting targets yet</EmptyTitle>
              <EmptyDescription>
                Create a hosting target on the fleet page first, then attach this system to it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <RadioGroup value={selectedId ?? undefined} onValueChange={setSelectedId}>
            {targets.map((target) => (
              <label
                key={target.id}
                htmlFor={`attach-beszel-target-${target.id}`}
                className='hover:bg-accent/50 flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2'
              >
                <RadioGroupItem value={target.id} id={`attach-beszel-target-${target.id}`} />
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

        <ResponsiveDialogFooter>
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
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
