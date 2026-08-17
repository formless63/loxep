/**
 * Band 3 — Operations health (loxep-jwm; refreshed by loxep-9m2).
 *
 * "Is anything broken right now": provider connections, the discovery
 * monitor fleet, order-sync freshness, purchase-sync/DNS-reconcile
 * freshness, this installation's own DNS/hosting estate, fleet-tool signals
 * (folded in from `computeFleetSignals`), and notification delivery. Every
 * chip pairs a tone with an icon, and every tile links to the settings/
 * market/infrastructure surface that can actually fix the thing it reports.
 */
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import {
  formatDateTime,
  formatDuration,
  formatQuantity,
  formatRate,
  formatRelativeTime
} from '@/lib/format';
import {
  consecutiveErrorsIcon,
  consecutiveErrorsTone,
  monitorTargetTypeLabel
} from '@/features/market/constants';
import { integrationServiceForProvider } from '@/features/settings/integrations-catalog';
import {
  connectionHealthIcon,
  connectionHealthLabel,
  connectionHealthTone,
  deliveryRateIcon,
  deliveryRateTone,
  fleetIcon,
  fleetProviderCountLabel,
  fleetProviderTone,
  FLEET_PROVIDER_LABELS,
  fleetTone,
  infrastructureIcon,
  infrastructureTone,
  otherSyncTargetTypeLabel,
  syncFreshnessIcon,
  syncFreshnessLabel,
  syncFreshnessTone
} from '@/features/dashboard/constants';
import {
  BAND_GRID_TINT,
  Band,
  FocusableLink,
  StatCard,
  StatIcon
} from '@/features/dashboard/components/dashboard-primitives';
import type {
  DashboardInfrastructureDto,
  DashboardMonitorFleetDto,
  DashboardNotificationHealthDto,
  DashboardOperationsDto,
  DashboardOrderSyncDto,
  DashboardOtherSyncTargetDto,
  DashboardProviderHealthDto
} from '@/server/dashboard-functions';
import type { FleetSignalsDto } from '@/server/infrastructure-functions';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';

function providerLabel(provider: string): string {
  return integrationServiceForProvider(provider)?.name ?? provider;
}

function ConnectionsCard({
  providers,
  connectionCount
}: {
  providers: DashboardProviderHealthDto[];
  connectionCount: number;
}) {
  return (
    <FocusableLink to='/settings/connections' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Connections</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatQuantity(connectionCount)}
          </CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-2'>
          {providers.length === 0 ? (
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.integrations />
                </EmptyMedia>
                <EmptyTitle>No provider connections</EmptyTitle>
                <EmptyDescription>
                  Connect an eBay account or a store to start observing and ingesting.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            providers.map((provider) => {
              const HealthIcon = connectionHealthIcon(provider);
              return (
                <div
                  key={provider.provider}
                  className='flex items-center justify-between gap-2 text-sm'
                >
                  <span className='truncate font-medium'>{providerLabel(provider.provider)}</span>
                  <Badge variant={connectionHealthTone(provider)}>
                    <HealthIcon />
                    <span className='tabular-nums'>{connectionHealthLabel(provider)}</span>
                  </Badge>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

function MonitorFleetCard({ monitors }: { monitors: DashboardMonitorFleetDto }) {
  const FleetIcon = fleetIcon(monitors);
  return (
    <StatCard
      label='Monitor fleet'
      value={`${formatQuantity(monitors.enabled)} / ${formatQuantity(monitors.total)}`}
      href='/market/monitors'
      icon={{ icon: Icons.radar, className: 'bg-chart-3/15 text-chart-3' }}
      footer={
        <div className='flex flex-wrap items-center gap-1.5'>
          <Badge variant={fleetTone(monitors)}>
            <FleetIcon />
            {monitors.erroring > 0
              ? `${formatQuantity(monitors.erroring)} erroring`
              : 'Polling cleanly'}
          </Badge>
          {monitors.backingOff > 0 && (
            <Badge variant='warning'>
              <Icons.clock />
              {formatQuantity(monitors.backingOff)} backing off
            </Badge>
          )}
          {monitors.overdue > 0 && (
            <Badge variant='warning'>
              <Icons.alertCircle />
              {formatQuantity(monitors.overdue)} overdue
            </Badge>
          )}
          <span className='text-muted-foreground' title={formatDateTime(monitors.lastSuccessAt)}>
            Last success {formatRelativeTime(monitors.lastSuccessAt)}
          </span>
        </div>
      }
    />
  );
}

function OrderSyncCard({ targets }: { targets: DashboardOrderSyncDto[] }) {
  return (
    <FocusableLink to='/settings/connections' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Order sync</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatQuantity(targets.filter((target) => target.enabled).length)}
          </CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-2'>
          {targets.length === 0 ? (
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.orders />
                </EmptyMedia>
                <EmptyTitle>Order sync is off</EmptyTitle>
                <EmptyDescription>
                  Turn it on per connection to ingest real orders, fees, and refunds.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            targets.map((target) => {
              const FreshnessIcon = syncFreshnessIcon(target);
              const ErrorIcon = consecutiveErrorsIcon(target.consecutiveErrors);
              return (
                <div key={target.id} className='flex flex-col gap-1 text-sm'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='truncate font-medium'>
                      {target.connectionName ?? monitorTargetTypeLabel(target.targetType)}
                    </span>
                    <Badge variant={syncFreshnessTone(target)}>
                      <FreshnessIcon />
                      {syncFreshnessLabel(target)}
                    </Badge>
                  </div>
                  <div className='flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
                    <span title={formatDateTime(target.lastSuccessAt)}>
                      Last success {formatRelativeTime(target.lastSuccessAt)}
                    </span>
                    <span>· every {formatDuration(target.intervalSeconds)}</span>
                    {target.consecutiveErrors > 0 && (
                      <Badge variant={consecutiveErrorsTone(target.consecutiveErrors)}>
                        <ErrorIcon />
                        {formatQuantity(target.consecutiveErrors)} errors
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

/**
 * `ebay_purchases` (inbound purchase ingestion) and `infrastructure_domain_
 * reconcile` (the DNS reconcile sweep) — the two target types loxep-9m2's
 * bug 1 used to mis-bucket as market monitors. Same freshness presentation
 * as {@link OrderSyncCard}, its own tile so neither type disappears again.
 */
function OtherSyncCard({ targets }: { targets: DashboardOtherSyncTargetDto[] }) {
  return (
    <FocusableLink to='/infrastructure/overview' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Purchase &amp; reconcile sync</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatQuantity(targets.filter((target) => target.enabled).length)}
          </CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-2'>
          {targets.length === 0 ? (
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.radar />
                </EmptyMedia>
                <EmptyTitle>Nothing polling here yet</EmptyTitle>
                <EmptyDescription>
                  eBay purchase ingestion and the DNS reconcile sweep are neither market monitors
                  nor order sync — they land here once either is running.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            targets.map((target) => {
              const FreshnessIcon = syncFreshnessIcon(target);
              const ErrorIcon = consecutiveErrorsIcon(target.consecutiveErrors);
              return (
                <div key={target.id} className='flex flex-col gap-1 text-sm'>
                  <div className='flex items-center justify-between gap-2'>
                    <span className='truncate font-medium'>
                      {target.connectionName ?? otherSyncTargetTypeLabel(target.targetType)}
                    </span>
                    <Badge variant={syncFreshnessTone(target)}>
                      <FreshnessIcon />
                      {syncFreshnessLabel(target)}
                    </Badge>
                  </div>
                  <div className='flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
                    <span>{otherSyncTargetTypeLabel(target.targetType)}</span>
                    <span title={formatDateTime(target.lastSuccessAt)}>
                      · last success {formatRelativeTime(target.lastSuccessAt)}
                    </span>
                    <span>· every {formatDuration(target.intervalSeconds)}</span>
                    {target.consecutiveErrors > 0 && (
                      <Badge variant={consecutiveErrorsTone(target.consecutiveErrors)}>
                        <ErrorIcon />
                        {formatQuantity(target.consecutiveErrors)} errors
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

/** This installation's own DNS/hosting estate (loxep-9m2) — see `DashboardInfrastructureDto`. */
function InfrastructureCard({ infrastructure }: { infrastructure: DashboardInfrastructureDto }) {
  const InfraIcon = infrastructureIcon(infrastructure);
  return (
    <FocusableLink to='/infrastructure/overview' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Hosting targets</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatQuantity(infrastructure.hostingTargetCount)}
          </CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-2'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <Badge variant={infrastructureTone(infrastructure)}>
              <InfraIcon />
              {infrastructure.unresolvedDriftCount > 0 ||
              infrastructure.recentFailedReconcileRunCount > 0
                ? 'Needs attention'
                : 'Reconciling cleanly'}
            </Badge>
            {infrastructure.unresolvedDriftCount > 0 && (
              <Badge variant='warning'>
                <Icons.alertCircle />
                {formatQuantity(infrastructure.unresolvedDriftCount)} DNS drift
              </Badge>
            )}
            {infrastructure.recentFailedReconcileRunCount > 0 && (
              <Badge variant='destructive'>
                <Icons.xCircle />
                {formatQuantity(infrastructure.recentFailedReconcileRunCount)} reconcile failures (
                {infrastructure.windowDays}d)
              </Badge>
            )}
          </div>
          <p className='text-sm text-muted-foreground'>
            {formatQuantity(infrastructure.domainCount)} managed domains.
          </p>
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

/**
 * loxep-cum's `computeFleetSignals`, folded in rather than re-derived (see
 * this feature's module doc on `computeFleetSignals`'s import). Witness-not-
 * verdict: each connected provider gets its own chip with its own counts —
 * this card never blends them into one page-level verdict, matching
 * `/infrastructure`'s own `fleet-signals-band.tsx`. A provider with no
 * connections renders NO chip at all ("absent renders absent, never green").
 */
function FleetSignalsCard({ signals }: { signals: FleetSignalsDto }) {
  const active = signals.providers.filter((provider) => provider.connectionCount > 0);
  return (
    <FocusableLink to='/infrastructure/overview' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Fleet signals</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatQuantity(active.length)}/{formatQuantity(signals.providers.length)}
          </CardTitle>
          {active.length === 0 && (
            <CardAction>
              <StatIcon icon={Icons.pulse} className='bg-chart-4/15 text-chart-4' />
            </CardAction>
          )}
        </CardHeader>
        <CardContent className='flex flex-col gap-2'>
          {active.length === 0 ? (
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.pulse />
                </EmptyMedia>
                <EmptyTitle>No fleet tools connected yet</EmptyTitle>
                <EmptyDescription>
                  Connect Beszel, Dockhand, Gatus, Tailscale, or Termix to see their own signals
                  here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            active.map((provider) => (
              <div
                key={provider.provider}
                className='flex items-center justify-between gap-2 text-sm'
              >
                <span className='truncate font-medium'>
                  {FLEET_PROVIDER_LABELS[provider.provider]}
                </span>
                <Badge variant={fleetProviderTone(provider)}>
                  <span className='tabular-nums'>{fleetProviderCountLabel(provider)}</span>
                </Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

function NotificationsCard({ notifications }: { notifications: DashboardNotificationHealthDto }) {
  const RateIcon = deliveryRateIcon(notifications.successRatePct);
  const settled = notifications.delivered + notifications.failed;

  return (
    <FocusableLink to='/settings/notifications' className='h-full'>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardDescription>Notification delivery ({notifications.windowDays}d)</CardDescription>
          <CardTitle className='text-2xl font-semibold tabular-nums'>
            {formatRate(notifications.successRatePct)}
          </CardTitle>
          {/* No settled attempt means no rate to plot and no trend to claim —
              the honest fallback is the tinted chart-token medallion. */}
          {settled === 0 && (
            <CardAction>
              <StatIcon icon={Icons.notification} className='bg-chart-4/15 text-chart-4' />
            </CardAction>
          )}
        </CardHeader>
        <CardContent className='flex flex-col gap-2'>
          <div className='flex flex-wrap items-center gap-1.5'>
            <Badge variant={deliveryRateTone(notifications.successRatePct)}>
              <RateIcon />
              {formatQuantity(notifications.delivered)} delivered
            </Badge>
            {notifications.failed > 0 && (
              <Badge variant='destructive'>
                <Icons.xCircle />
                {formatQuantity(notifications.failed)} failed
              </Badge>
            )}
            {notifications.pending > 0 && (
              <Badge variant='outline'>
                <Icons.clock />
                {formatQuantity(notifications.pending)} pending
              </Badge>
            )}
          </div>
          <p className='text-sm text-muted-foreground'>
            {settled === 0
              ? 'No delivery has settled in the window — event detection and delivery are separate, so this is quiet, not broken.'
              : 'Share of settled delivery attempts that reached their endpoint.'}
          </p>
        </CardContent>
      </Card>
    </FocusableLink>
  );
}

export function OperationsBand({ data }: { data: DashboardOperationsDto }) {
  return (
    <Band
      title='Operations'
      description="Connections, the discovery/order/purchase/reconcile polling fleet, this installation's own DNS and hosting estate, and notification delivery."
      action={{ label: 'Settings', to: '/settings/overview' }}
    >
      <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4', BAND_GRID_TINT)}>
        <div className='min-w-0'>
          <ConnectionsCard providers={data.providers} connectionCount={data.connectionCount} />
        </div>
        <MonitorFleetCard monitors={data.monitors} />
        <div className='min-w-0'>
          <OrderSyncCard targets={data.orderSync} />
        </div>
        <div className='min-w-0'>
          <OtherSyncCard targets={data.otherSync} />
        </div>
        <div className='min-w-0'>
          <InfrastructureCard infrastructure={data.infrastructure} />
        </div>
        <div className='min-w-0'>
          <FleetSignalsCard signals={data.fleetSignals} />
        </div>
        <div className='min-w-0'>
          <NotificationsCard notifications={data.notifications} />
        </div>
      </div>
    </Band>
  );
}
