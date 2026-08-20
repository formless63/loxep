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
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import {
  candidateManagedDomainZonesQuery,
  managedDomainQuery,
  managedDomainsQuery
} from '@/features/infrastructure/api/queries';
import { attachManagedDomainZone } from '@/server/infrastructure-functions';
import type { CandidateZoneDto } from '@/server/infrastructure-functions';

/**
 * "Attach an existing zone" (`loxep-8f8`) — the operator confirmation Rule
 * P11 requires for adopt-into-intent ("Loxep never guesses a foreign key"):
 * this dialog lists the LIVE Cloudflare zones matching this domain's own
 * name (bounded to one page, filtered server-side) and requires an explicit
 * pick before anything is written. No zone is created, modified, or deleted
 * at Cloudflare — the only write is `managed_domains.external_zone_id` (+
 * whatever of `provider_zone_status`/`zone_nameservers` the read carried),
 * via `attachManagedDomainZone`.
 *
 * Two entry points share this one component, distinguished by
 * `currentExternalZoneId`:
 * - `null` — the quiet, common case (`domains/new` never sets a zone). The
 *   caller renders this as "Attach zone", and the write needs no `replace`
 *   flag.
 * - non-`null` — "Change zone", a DELIBERATE re-point at a different zone.
 *   The caller always passes `replace: true` on submit here — the button
 *   itself is the deliberate act the write's own refusal-to-overwrite exists
 *   to gate (see `ManagedDomainsService.attachZone`'s doc): picking the
 *   SAME zone again is a harmless no-op refresh either way.
 */
export default function AttachZoneDialog({
  domainId,
  domainName,
  currentExternalZoneId,
  open,
  onOpenChange
}: {
  domainId: string;
  domainName: string;
  currentExternalZoneId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [selectedZoneId, setSelectedZoneId] = React.useState<string | null>(null);
  const query = useQuery({
    ...candidateManagedDomainZonesQuery(domainId),
    enabled: open
  });
  const zones: CandidateZoneDto[] = query.data?.zones ?? [];

  const mutation = useMutation({
    mutationFn: (zone: CandidateZoneDto) =>
      attachManagedDomainZone({
        data: {
          domainId,
          externalZoneId: zone.externalZoneId,
          providerZoneStatus: zone.status,
          zoneNameservers: zone.nameservers,
          replace: currentExternalZoneId !== null
        }
      }),
    onSuccess: async () => {
      toast.success(`Zone attached — "Sync now" can reconcile "${domainName}" now.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: managedDomainQuery(domainName).queryKey }),
        queryClient.invalidateQueries({ queryKey: managedDomainsQuery.queryKey })
      ]);
      close(false);
    },
    onError: (error) => toastError(error, 'Failed to attach this zone')
  });

  function close(next: boolean) {
    if (!next) setSelectedZoneId(null);
    onOpenChange(next);
  }

  const selected = zones.find((zone) => zone.externalZoneId === selectedZoneId) ?? null;

  return (
    <ResponsiveDialog open={open} onOpenChange={close}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {currentExternalZoneId === null ? 'Attach a zone' : 'Change zone'} for "{domainName}"
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Live read from Cloudflare, filtered to a zone named "{domainName}". Loxep creates
            nothing at the provider — picking a zone here only tells Loxep which one already at
            Cloudflare to reconcile against.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {query.isLoading ? (
          <p className='text-muted-foreground text-sm'>Reading Cloudflare zones…</p>
        ) : query.isError ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.alertCircle />
              </EmptyMedia>
              <EmptyTitle>Could not read Cloudflare zones</EmptyTitle>
              <EmptyDescription>
                {query.error instanceof Error ? query.error.message : 'Unknown error.'}
              </EmptyDescription>
            </EmptyHeader>
            <Button type='button' variant='outline' size='sm' onClick={() => query.refetch()}>
              Retry
            </Button>
          </Empty>
        ) : zones.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.world />
              </EmptyMedia>
              <EmptyTitle>No zone named "{domainName}" at this connection</EmptyTitle>
              <EmptyDescription>
                Create it at the provider first, or use a provisioning template to create the domain
                and its zone together.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <RadioGroup value={selectedZoneId ?? undefined} onValueChange={setSelectedZoneId}>
            {zones.map((zone) => (
              <label
                key={zone.externalZoneId}
                htmlFor={`candidate-zone-${zone.externalZoneId}`}
                className='hover:bg-accent/50 flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2'
              >
                <RadioGroupItem
                  value={zone.externalZoneId}
                  id={`candidate-zone-${zone.externalZoneId}`}
                  className='mt-1'
                />
                <span className='flex min-w-0 flex-1 flex-col gap-1'>
                  <span className='flex flex-wrap items-center gap-2'>
                    <span className='font-medium'>{zone.name}</span>
                    <Badge variant='outline'>{zone.status}</Badge>
                    {zone.externalZoneId === currentExternalZoneId && (
                      <Badge variant='secondary'>currently attached</Badge>
                    )}
                  </span>
                  {zone.nameservers.length > 0 && (
                    <span className='text-muted-foreground font-mono text-xs'>
                      {zone.nameservers.join(', ')}
                    </span>
                  )}
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
            disabled={selected === null || mutation.isPending}
            onClick={() => selected !== null && mutation.mutate(selected)}
          >
            {currentExternalZoneId === null ? 'Attach' : 'Change zone'}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
