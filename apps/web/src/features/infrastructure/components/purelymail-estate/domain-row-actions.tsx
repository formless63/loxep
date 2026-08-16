import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { toastError } from '@/lib/errors';
import {
  triggerPurelymailDomainSync,
  triggerPurelymailMailboxSync
} from '@/server/purelymail-estate-functions';
import type { PurelymailSyncActionDto } from '@/server/purelymail-estate-functions';

/**
 * A blocked run is neither hidden nor silently inert (Rule P14) — it is the
 * mutation's own, REAL structured result from `MailSyncService`, toasted
 * verbatim rather than guessed at before the click.
 */
function describeResult(action: string, result: PurelymailSyncActionDto): string {
  if (result.blocked) {
    return `${action} blocked — this connection's write policy refused the write. Raise its tier on Settings → Connections to unblock it.`;
  }
  return `${action}: ${result.outcome} (${result.status})`;
}

/**
 * Mounts `MailSyncService.runMailDomainSync`/`runMailboxSync` — the SAME
 * already-gated service calls the worker's `infrastructure.ensure-mail-
 * domain`/`infrastructure.sync-mailboxes` tasks make — on a domain row that
 * already has a `mail_domains` registration on THIS connection (Estate
 * Browsers Design §3.2, owner ruling 2026-08-16 #3). Admin-only; the server
 * enforces it, and a non-admin's click surfaces the refusal as a toast,
 * matching every other admin-only mutation in this feature area.
 */
export function PurelymailDomainRowActions({
  connectionId,
  domainId
}: {
  connectionId: string;
  domainId: string;
}) {
  const domainSyncMutation = useMutation({
    mutationFn: () => triggerPurelymailDomainSync({ data: { connectionId, domainId } }),
    onSuccess: (result) => {
      const message = describeResult('Domain sync', result);
      if (result.blocked) toast.warning(message);
      else toast.success(message);
    },
    onError: (error) => toastError(error, 'Failed to sync this domain')
  });
  const mailboxSyncMutation = useMutation({
    mutationFn: () => triggerPurelymailMailboxSync({ data: { connectionId, domainId } }),
    onSuccess: (result) => {
      const message = describeResult('Mailbox sync', result);
      if (result.blocked) toast.warning(message);
      else toast.success(message);
    },
    onError: (error) => toastError(error, 'Failed to sync mailboxes for this domain')
  });

  return (
    <div className='flex items-center justify-end gap-2'>
      <Button
        size='sm'
        variant='outline'
        disabled={domainSyncMutation.isPending}
        onClick={() => domainSyncMutation.mutate()}
      >
        Sync now
      </Button>
      <Button
        size='sm'
        variant='outline'
        disabled={mailboxSyncMutation.isPending}
        onClick={() => mailboxSyncMutation.mutate()}
      >
        Sync mailboxes
      </Button>
    </div>
  );
}
