import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Icons } from '@/components/icons';
import TypedConfirmDialog from '@/components/ui/typed-confirm-dialog';
import { toastError } from '@/lib/errors';
import { managedDomainQuery } from '@/features/infrastructure/api/queries';
import ProxyResourceRow, { ProxyResourceEmptyState } from './proxy-resource-row';
import { requestProxyResourceDomainApply } from '@/server/infrastructure-functions';
import type { ProxyResourceChainDto } from '@/server/infrastructure-functions';

/**
 * Whether ANY resource's connection is authorized for a tier-1 (additive)
 * write — the coarse, domain-level question this panel's Apply button needs
 * before offering the action at all. `writePolicyTier === null` means the
 * resource's hosting target has no linked Pangolin connection at all, which
 * is a DIFFERENT reason to disable than a `'read_only'` policy — both
 * render, but distinctly, per the design's "a blocked step names the exact
 * remedy" rule applied one level up, before the operator even clicks.
 */
function summarizeApplyReadiness(resources: ProxyResourceChainDto[]): {
  anyApplyable: boolean;
  anyUnlinked: boolean;
  anyReadOnly: boolean;
} {
  let anyApplyable = false;
  let anyUnlinked = false;
  let anyReadOnly = false;
  for (const resource of resources) {
    if (resource.connectionId === null) {
      anyUnlinked = true;
      continue;
    }
    if (resource.writePolicyTier === 'read_only' || resource.writePolicyTier === null) {
      anyReadOnly = true;
      continue;
    }
    anyApplyable = true;
  }
  return { anyApplyable, anyUnlinked, anyReadOnly };
}

/**
 * The M4 (loxep-acj.4) apply affordance. Admin-only (the server function
 * enforces it; a non-admin's click surfaces the refusal as a toast, the
 * same pattern `requestDomainResync`'s "Sync now" button already uses for
 * its own admin gate). Tier-1 only — this button applies every declared
 * resource's ADDITIVE operations (create a resource, add a target, add a
 * rule) for the whole domain in one action; it can never disable or repoint
 * anything (M4 ships no tier-2 verb).
 */
function ApplyProxyResourcesButton({
  domainId,
  domainName,
  resources
}: {
  domainId: string;
  domainName: string;
  resources: ProxyResourceChainDto[];
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = React.useState(false);
  const readiness = summarizeApplyReadiness(resources);

  const mutation = useMutation({
    mutationFn: () => requestProxyResourceDomainApply({ data: { domainId } }),
    onSuccess: async () => {
      toast.success('Apply enqueued — new Pangolin resources, targets, and rules will be created');
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: managedDomainQuery(domainName).queryKey });
    },
    onError: (error) => toastError(error, 'Failed to enqueue the apply')
  });

  if (resources.length === 0) return null;

  if (!readiness.anyApplyable) {
    return (
      <Alert>
        <Icons.lock />
        <AlertTitle>Apply is not available yet</AlertTitle>
        <AlertDescription>
          {readiness.anyReadOnly
            ? "This domain's Pangolin connection is set to read_only. An admin must allow at least additive writes for the connection on /settings/connections before Loxep can create anything here."
            : "This domain's proxy resource has no linked Pangolin connection yet."}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <>
      <div className='flex flex-col gap-2'>
        {readiness.anyReadOnly && (
          <p className='text-muted-foreground text-sm'>
            One or more of this domain&apos;s resources are on a connection still set to read_only
            and will be skipped (recorded as blocked, not failed) until an admin allows writes for
            that connection.
          </p>
        )}
        <div>
          <Button size='sm' onClick={() => setConfirming(true)}>
            <Icons.add />
            Apply
          </Button>
        </div>
      </div>
      <TypedConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Apply proxy resources for "${domainName}"?`}
        description={
          <>
            This creates every Pangolin resource, target, and rule this domain declares but Pangolin
            does not have yet — additive only; nothing existing is changed, disabled, or removed.
            Loxep never manages its own resource or the Pangolin dashboard&apos;s own resource, even
            if one is somehow declared here.
          </>
        }
        confirmText={domainName}
        actionLabel='Apply'
        pending={mutation.isPending}
        onConfirm={() => mutation.mutate()}
      />
    </>
  );
}

/**
 * The domain-detail panel for the Pangolin chain design: "domain ->
 * Cloudflare record -> Pangolin resource -> hosting target". The first two
 * links are already rendered above this panel (the "Desired records" list
 * on `/infrastructure/domains/$name`, including any `owner='proxy_resource'`
 * A/AAAA rows) — this panel is the third link.
 *
 * Milestone 2 (loxep-acj.2) shipped this read-only. Milestone 4
 * (loxep-acj.4) adds the Apply action above — still nothing here lets an
 * operator EDIT a resource or its rules; declaring intent stays a later
 * milestone's surface, per the design's own milestone table.
 */
export default function ProxyChainPanel({
  domainId,
  domainName,
  resources
}: {
  domainId: string;
  domainName: string;
  resources: ProxyResourceChainDto[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Proxy resources</CardTitle>
        <CardDescription>
          The Pangolin resource(s) fronting this domain, and the hosting target each points at.
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {resources.length === 0 ? (
          <ProxyResourceEmptyState
            title='No proxy resource declared'
            description='This domain has no declared Pangolin resource yet.'
          />
        ) : (
          <>
            <ul className='flex flex-col gap-3'>
              {resources.map((resource) => (
                <ProxyResourceRow
                  key={resource.id}
                  resource={resource}
                  linkTo={{
                    to: '/infrastructure/fleet/$name',
                    params: { name: resource.hostingTargetName },
                    label: resource.hostingTargetName
                  }}
                />
              ))}
            </ul>
            <ApplyProxyResourcesButton
              domainId={domainId}
              domainName={domainName}
              resources={resources}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
