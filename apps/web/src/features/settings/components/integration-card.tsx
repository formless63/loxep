import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { toastError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { integrationsEnabledQuery } from '@/features/settings/api/queries';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type {
  IntegrationServiceId,
  IntegrationStatus,
  IntegrationStatusTone
} from '@/features/settings/integrations-catalog';
import { setIntegrationEnabled } from '@/server/admin-functions';

/**
 * `partial` ("set up but missing a piece") is an at-risk/operator-actionable
 * state, not a failure — it renders `warning`, never the same alarm red as a
 * genuine error. `unconfigured` is a neutral not-started state.
 */
const STATUS_TONE: Record<IntegrationStatusTone, Tone> = {
  ready: 'success',
  partial: 'warning',
  unconfigured: 'outline'
};

/** Status pill plus the service's supporting facts (never credential material). */
export function IntegrationStatusBadges({ status }: { status: IntegrationStatus }) {
  return (
    <div className='flex flex-wrap items-center gap-2 text-sm'>
      <ToneBadge tone={STATUS_TONE[status.tone]}>{status.label}</ToneBadge>
      {status.details.map((detail) => (
        <Badge key={detail} variant='outline'>
          {detail}
        </Badge>
      ))}
      {status.warning && (
        <ToneBadge tone='warning' title={status.warning.title}>
          {status.warning.label}
        </ToneBadge>
      )}
    </div>
  );
}

/**
 * One catalog card: what the service is, how far its set-up has got, and the
 * single action that takes an operator to the rest of it. Every card on
 * `/settings/integrations` is this shell so the catalog reads as one surface.
 *
 * `disabled` (loxep-dgg) marks a card revealed only by the "Show disabled"
 * affordance — the provider is hidden from the catalog/connection-add
 * surfaces by the `integrations.enabled` setting. It is purely visual (a
 * dimmed card plus a badge): the provider's own status/data is unaffected,
 * matching the setting's "display preference, not a kill switch" rule.
 */
export function IntegrationCard({
  name,
  description,
  status,
  isPending,
  action,
  disabled = false,
  children
}: {
  name: string;
  description: string;
  status: IntegrationStatus;
  isPending?: boolean;
  action: ReactNode;
  /** Hidden by the `integrations.enabled` setting, shown via "Show disabled". */
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <Card className={cn('flex h-full flex-col', disabled && 'opacity-75')}>
      <CardHeader className='flex flex-row items-start justify-between gap-4'>
        <div className='min-w-0'>
          <div className='flex flex-wrap items-center gap-2'>
            <CardTitle className='text-base'>{name}</CardTitle>
            {disabled && (
              <ToneBadge
                tone='warning'
                title='Hidden from the catalog and connection-add options by this installation’s settings. Any existing accounts keep working unchanged.'
              >
                Disabled here
              </ToneBadge>
            )}
          </div>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className='flex shrink-0 flex-col items-end gap-2'>{action}</div>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col justify-end gap-3'>
        {isPending === true ? (
          <Skeleton className='h-6 w-48' />
        ) : (
          <IntegrationStatusBadges status={status} />
        )}
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * Admin-only per-card visibility control (loxep-8ja.4, settings-ux-design.md
 * §1 row 17, §3 "Managed elsewhere") — the catalog grid's row editor for the
 * `integrations.enabled` map, keyed by the catalog's own provider list (this
 * grid's `integrationServices`) the same way `WritePolicyCell`
 * (`connections-table/write-policy-cell.tsx`) is keyed by the connections
 * table's own connection list: one `useMutation` per row, writing through
 * `setIntegrationEnabled`, never a page-wide batch. A `Switch` rather than
 * `WritePolicyCell`'s `Select` because this map's value is boolean, not a
 * four-value tier — the same shape, the boolean-native control.
 *
 * A pure DISPLAY toggle: it never touches `connections` rows or worker job
 * state (the setting's own doc — an already-connected provider keeps
 * syncing and its jobs keep running unchanged either way). The card's
 * "Disabled here" badge (`IntegrationCard`, above) already says so and is
 * visible to every visitor, admin or not — honest about what disabling
 * actually hides (the catalog and connection-add pickers) versus what it
 * does not (existing connections, their jobs).
 */
export function IntegrationEnabledToggle({
  serviceId,
  serviceName,
  enabled
}: {
  serviceId: IntegrationServiceId;
  serviceName: string;
  enabled: boolean;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (nextEnabled: boolean) =>
      setIntegrationEnabled({ data: { id: serviceId, enabled: nextEnabled } }),
    onSuccess: (_data, nextEnabled) => {
      toast.success(nextEnabled ? `${serviceName} shown in the catalog` : `${serviceName} hidden`);
      queryClient.invalidateQueries({ queryKey: integrationsEnabledQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update integration visibility')
  });

  const switchId = `integration-enabled-${serviceId}`;

  return (
    <div className='flex items-center gap-2'>
      <Switch
        id={switchId}
        size='sm'
        checked={enabled}
        onCheckedChange={(nextEnabled) => mutation.mutate(nextEnabled)}
        disabled={mutation.isPending}
        aria-label={
          enabled ? `Hide ${serviceName} from the catalog` : `Show ${serviceName} in the catalog`
        }
      />
      <Label htmlFor={switchId} className='text-muted-foreground text-xs font-normal'>
        {enabled ? 'Shown' : 'Hidden'}
      </Label>
    </div>
  );
}
