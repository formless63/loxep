import type { ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
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
 * Admin-only per-card enable/disable control (loxep-dgg) — the catalog
 * grid's toggle for the `integrations.enabled` setting, mirroring the
 * existing Enable/Disable `Button` pattern
 * (`notification-endpoints-table/cell-action.tsx`) rather than introducing a
 * new control shape. Writes through `setIntegrationEnabled`, which is a pure
 * display toggle — it never touches `connections` rows or worker state.
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

  return (
    <Button
      size='sm'
      variant='ghost'
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(!enabled)}
    >
      {enabled ? 'Disable' : 'Enable'}
    </Button>
  );
}
