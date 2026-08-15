import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/format';
import { unmatchedTailscaleDevicesQuery } from '@/features/infrastructure/api/queries';
import { setTailscaleDeviceIgnored } from '@/server/infrastructure-functions';
import type { UnmatchedTailscaleDeviceDto } from '@/server/infrastructure-functions';

export interface CellActionHandlers {
  onLink: (device: UnmatchedTailscaleDeviceDto) => void;
  onDeclare: (device: UnmatchedTailscaleDeviceDto) => void;
}

/**
 * The candidates panel's three row actions (loxep-50t §4): link, declare,
 * ignore. "Link"/"Declare" open dialogs owned by the panel (they need a
 * target list / the new-hosting-target form); "Ignore"/"Unignore" is a
 * direct mutation here, mirroring `dns-drift-panel.tsx`'s plain-button
 * dismiss (no confirm dialog — reversible, not destructive).
 */
export function CellAction({
  data,
  onLink,
  onDeclare
}: CellActionHandlers & { data: UnmatchedTailscaleDeviceDto }) {
  const queryClient = useQueryClient();

  const ignoreMutation = useMutation({
    mutationFn: (ignored: boolean) => {
      if (data.externalId === null) {
        throw new Error('This device has no tailnet id yet — refresh after the next sweep.');
      }
      return setTailscaleDeviceIgnored({ data: { externalId: data.externalId, ignored } });
    },
    onSuccess: async (_result, ignored) => {
      toast.success(ignored ? 'Ignored' : 'Un-ignored');
      await queryClient.invalidateQueries({ queryKey: unmatchedTailscaleDevicesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update')
  });

  const noExternalId = data.externalId === null;

  if (data.ignoredAt !== null) {
    return (
      <div className='flex items-center justify-end gap-2'>
        <span className='text-muted-foreground text-xs'>
          Ignored {formatRelativeTime(data.ignoredAt)}
        </span>
        <Button
          size='sm'
          variant='ghost'
          disabled={ignoreMutation.isPending}
          onClick={() => ignoreMutation.mutate(false)}
        >
          Unignore
        </Button>
      </div>
    );
  }

  return (
    <div className='flex justify-end gap-2'>
      <Button size='sm' variant='outline' disabled={noExternalId} onClick={() => onLink(data)}>
        Link
      </Button>
      <Button size='sm' variant='outline' onClick={() => onDeclare(data)}>
        Declare
      </Button>
      <Button
        size='sm'
        variant='ghost'
        disabled={ignoreMutation.isPending || noExternalId}
        onClick={() => ignoreMutation.mutate(true)}
      >
        Ignore
      </Button>
    </div>
  );
}
