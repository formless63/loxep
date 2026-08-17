import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import TypedConfirmDialog from '@/components/ui/typed-confirm-dialog';
import { toastError } from '@/lib/errors';
import { estateConnectionSummaryQuery } from '@/features/estate/api/queries';
import { PROVIDER_WRITE_POLICY_TIER_VALUES } from '@/features/settings/constants';
import { deletePurelymailRoutingRule } from '@/server/purelymail-estate-functions';
import type { PurelymailMailboxAdminActionDto } from '@/server/purelymail-estate-functions';

const ACCESS_AFFECTING_RANK = PROVIDER_WRITE_POLICY_TIER_VALUES.indexOf('access_affecting');

/**
 * Row-level "Delete…" for one routing rule on the Purelymail estate page
 * (loxep-47o.11) — mounts `MailboxAdminService.deleteRoutingRule`,
 * destructive, tier `access_affecting`-or-higher, typed confirmation of the
 * rule's own `<matchUser>@<domainName>` pattern. `createRoutingRule` has NO
 * row or section affordance here at all: Estate Browsers Design §3.2 names no
 * sanctioned home for a create action on this page, so it stays unmounted
 * (Rule P10) — this component is delete-only, matching the bead's own
 * fallback instruction.
 *
 * Only rendered where Loxep has a `mailboxes` intent row for this rule (same
 * `loxep !== null` gate `PurelymailMailboxRowActions` uses), since the
 * reconcile run this writes needs a `managed_domains.id` subject.
 */
export function PurelymailRoutingRuleRowActions({
  connectionId,
  domainId,
  routingRuleId,
  matchUser,
  domainName
}: {
  connectionId: string;
  domainId: string;
  routingRuleId: number;
  matchUser: string;
  domainName: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const { data: summary } = useQuery(estateConnectionSummaryQuery(connectionId));

  const tier = summary?.writePolicy.tier ?? null;
  const tierRank = tier === null ? -1 : PROVIDER_WRITE_POLICY_TIER_VALUES.indexOf(tier);
  const blocked = tierRank < ACCESS_AFFECTING_RANK;
  const confirmText = `${matchUser}@${domainName}`;

  const mutation = useMutation({
    mutationFn: (confirmationText: string) =>
      deletePurelymailRoutingRule({
        data: { connectionId, domainId, routingRuleId, confirmationText }
      }),
    onSuccess: async (result: PurelymailMailboxAdminActionDto) => {
      setConfirming(false);
      if (result.outcome === 'write_policy_blocked') {
        toast.warning(
          `Delete blocked — this connection's write policy refused the write. Raise its tier on Settings → Connections to unblock it.`
        );
      } else {
        toast.success(
          result.outcome === 'already_absent'
            ? `That routing rule was already gone at Purelymail.`
            : `Routing rule for "${confirmText}" deleted at Purelymail.`
        );
      }
      await queryClient.invalidateQueries({
        queryKey: ['infrastructure', 'purelymail', connectionId, 'routing-rules']
      });
    },
    onError: (error) => toastError(error, `Failed to delete the routing rule for ${confirmText}`)
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
              ? `Blocked: this connection's write policy must be "Access-affecting writes" or higher to delete a routing rule — raise it on Settings → Connections.`
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
        title={`Delete this routing rule?`}
        description={
          <>
            This deletes the routing rule matching <span className='font-mono'>{confirmText}</span>{' '}
            at Purelymail — mail addressed to it stops being forwarded immediately. Purelymail's
            stored credential is a fully-scoped account token with no per-rule scoping.
          </>
        }
        confirmText={confirmText}
        actionLabel='Delete routing rule'
        variant='destructive'
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate(confirmText)}
      />
    </>
  );
}
