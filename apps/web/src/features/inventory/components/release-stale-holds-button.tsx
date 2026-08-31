import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { releaseStaleHolds } from '@/server/inventory-functions';

/**
 * Forces an off-cycle `inventory.expire-stale-holds` run (loxep-souz).
 *
 * The sweep already runs hourly on its own cron item, so this is a
 * convenience for an operator staring at an `available to sell` figure a
 * fallen-through reservation is suppressing — not the mechanism. It ENQUEUES
 * (the server function's job key makes a double-click one run), so the toast
 * promises a queued sweep rather than a finished one: claiming rows were
 * released before the worker has run would be a lie the UI cannot back up.
 */
export default function ReleaseStaleHoldsButton() {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => releaseStaleHolds(),
    onSuccess: () => {
      toast.success('Stale-hold sweep queued — expired reservations clear within a moment');
      // The sweep runs in the worker, so nothing is refetchable yet; the
      // invalidation just makes the next view of this item honest once it has.
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => toastError(error, 'Could not queue the stale-hold sweep')
  });

  return (
    <Button
      type='button'
      variant='outline'
      size='sm'
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? <Icons.spinner className='animate-spin' /> : <Icons.refresh />}
      Release stale holds
    </Button>
  );
}
