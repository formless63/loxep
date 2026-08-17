import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import TypedConfirmDialog from '@/components/ui/typed-confirm-dialog';
import { toastError } from '@/lib/errors';
import { estateConnectionSummaryQuery } from '@/features/estate/api/queries';
import { PROVIDER_WRITE_POLICY_TIER_VALUES } from '@/features/settings/constants';
import { deletePurelymailMailboxNow } from '@/server/purelymail-estate-functions';
import type { PurelymailMailboxAdminActionDto } from '@/server/purelymail-estate-functions';

const ACCESS_AFFECTING_RANK = PROVIDER_WRITE_POLICY_TIER_VALUES.indexOf('access_affecting');

/**
 * Row-level "Delete…" for one mailbox on the Purelymail estate page
 * (loxep-47o.11) — mounts `MailboxAdminService.deleteMailboxNow`, destructive,
 * tier `access_affecting`-or-higher, typed confirmation of the full address.
 * Only rendered for a row Loxep has a `mailboxes` intent record for (Rule
 * P10's own precedent — `PurelymailDomainRowActions` mounts the same way,
 * gated on `loxep !== null`), since the reconcile run this writes needs a
 * `managed_domains.id` subject.
 *
 * Rule P14: policy currently forbidding this write renders VISIBLY BLOCKED
 * with the flip named, before any click — reusing the SAME
 * `estateConnectionSummaryQuery` the page header already fetches, so this
 * never surprises an operator with a post-click refusal.
 */
export function PurelymailMailboxRowActions({
  connectionId,
  domainId,
  address
}: {
  connectionId: string;
  domainId: string;
  address: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const { data: summary } = useQuery(estateConnectionSummaryQuery(connectionId));

  const tier = summary?.writePolicy.tier ?? null;
  const tierRank = tier === null ? -1 : PROVIDER_WRITE_POLICY_TIER_VALUES.indexOf(tier);
  const blocked = tierRank < ACCESS_AFFECTING_RANK;

  const mutation = useMutation({
    mutationFn: (confirmationText: string) =>
      deletePurelymailMailboxNow({ data: { connectionId, domainId, address, confirmationText } }),
    onSuccess: async (result: PurelymailMailboxAdminActionDto) => {
      setConfirming(false);
      if (result.outcome === 'write_policy_blocked') {
        toast.warning(
          `Delete blocked — this connection's write policy refused the write. Raise its tier on Settings → Connections to unblock it.`
        );
      } else {
        toast.success(
          result.outcome === 'already_absent'
            ? `${address} was already gone at Purelymail.`
            : `${address} deleted at Purelymail.`
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ['infrastructure', 'purelymail', connectionId, 'mailboxes']
      });
    },
    onError: (error) => toastError(error, `Failed to delete ${address}`)
  });

  return (
    <>
      <div className='flex items-center justify-end gap-2'>
        <Button
          size='sm'
          variant='outline'
          disabled={blocked}
          title={
            blocked
              ? `Blocked: this connection's write policy must be "Access-affecting writes" or higher to delete a mailbox — raise it on Settings → Connections.`
              : undefined
          }
          onClick={() => setConfirming(true)}
        >
          Delete…
        </Button>
        {blocked && (
          <span className='text-muted-foreground text-xs'>
            blocked — needs access-affecting tier
          </span>
        )}
      </div>
      <TypedConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete "${address}"?`}
        description={
          <>
            This deletes the mailbox and its mail at Purelymail — permanently and immediately.
            Purelymail's stored credential is a fully-scoped account token with no per-mailbox
            scoping, so this action reaches every mailbox on the account this connection can see.
          </>
        }
        confirmText={address}
        actionLabel='Delete mailbox'
        variant='destructive'
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate(address)}
      />
    </>
  );
}
