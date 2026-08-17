import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BrandIcon } from '@/components/ui/brand-icon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { PROVIDER_BRAND_ICON_FALLBACKS, PROVIDER_BRAND_ICONS } from '@/config/provider-brand-icons';
import { formatDateTime, formatRate, formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type {
  FleetHeartbeatMirrorDto,
  FleetProvider,
  FleetProviderSignalDto,
  FleetSignalsDto
} from '@/server/infrastructure-functions';

/**
 * The `/infrastructure` overview "fleet signals" band (loxep-cum) — what
 * Beszel/Dockhand/Gatus/Tailscale/Termix's already-shipped connection probes
 * (`packages/app/src/fleet-health.ts`) can honestly show TODAY, aggregated
 * per PROVIDER only (never a cross-tool merge — see the module doc on
 * `computeFleetSignals` in `@/server/infrastructure-functions`).
 *
 * Three rules from the design beads, applied here:
 *
 * - **Absent renders absent, never green.** A provider with zero connections
 *   renders NO tile at all — {@link ProviderTile} returns `null` rather than a
 *   grey/zero card that could read as "checked and fine".
 * - **Witness-not-verdict, at this granularity.** Each tile's badge is a
 *   COUNT ("1 of 2 failing"), never a verdict word. There is no page-level
 *   aggregate chip anywhere in this file that blends providers together.
 * - **Every panel stamps its own clock.** Each tile renders ITS OWN
 *   "Loxep checked …" line from that provider's own `lastCheckedAt` — never a
 *   single band-level "last updated".
 */

const FLEET_PROVIDER_LABELS: Record<FleetProvider, string> = {
  tailscale: 'Tailscale',
  beszel: 'Beszel',
  dockhand: 'Dockhand',
  gatus: 'Gatus',
  termix: 'Termix'
};

const FLEET_PROVIDER_DESCRIPTIONS: Record<FleetProvider, string> = {
  tailscale: 'Private network reachability',
  beszel: 'Host metrics agents',
  dockhand: 'Container hosts',
  gatus: 'Service uptime checks',
  termix: 'SSH access'
};

/**
 * A COUNT-shaped label, never a verdict — "3 failing, 1 not yet checked of 5"
 * rather than "unhealthy". Falls back to "N of M ok" only when nothing is
 * failing/degraded/unknown/unchecked, which is itself still a count.
 */
function connectionCountLabel(provider: FleetProviderSignalDto): string {
  const parts: string[] = [];
  if (provider.failingCount > 0) parts.push(`${provider.failingCount} failing`);
  if (provider.degradedCount > 0) parts.push(`${provider.degradedCount} degraded`);
  if (provider.unknownCount > 0) parts.push(`${provider.unknownCount} unknown`);
  if (provider.uncheckedCount > 0) parts.push(`${provider.uncheckedCount} not yet checked`);
  if (parts.length === 0) return `${provider.okCount} of ${provider.connectionCount} ok`;
  return `${parts.join(', ')} of ${provider.connectionCount}`;
}

function toneFor(provider: FleetProviderSignalDto): Tone {
  if (provider.failingCount > 0) return 'destructive';
  if (provider.degradedCount > 0 || provider.unknownCount > 0) return 'warning';
  if (provider.okCount > 0) return 'success';
  return 'secondary';
}

function ProviderTile({ provider }: { provider: FleetProviderSignalDto }) {
  // Absent, not green: nothing configured must never render a tile at all.
  if (provider.connectionCount === 0) return null;

  const tone = toneFor(provider);

  return (
    <Card className='@container/card h-full'>
      <CardHeader>
        <div className='flex flex-wrap items-center justify-between gap-2'>
          <div className='flex items-center gap-2'>
            <BrandIcon
              mark={PROVIDER_BRAND_ICONS[provider.provider]}
              fallback={PROVIDER_BRAND_ICON_FALLBACKS[provider.provider]}
              name={FLEET_PROVIDER_LABELS[provider.provider]}
              size={20}
            />
            <CardTitle className='text-sm font-medium'>
              {FLEET_PROVIDER_LABELS[provider.provider]}
            </CardTitle>
          </div>
          <ToneBadge tone={tone}>{connectionCountLabel(provider)}</ToneBadge>
        </div>
        <CardDescription>{FLEET_PROVIDER_DESCRIPTIONS[provider.provider]}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-1'>
        {provider.summary ? (
          <p className='text-lg font-semibold tabular-nums'>{provider.summary}</p>
        ) : (
          <p className='text-muted-foreground text-sm'>Not reporting yet.</p>
        )}
        {provider.note && <p className='text-muted-foreground text-xs'>{provider.note}</p>}
        <p
          className='text-muted-foreground mt-1 text-xs'
          title={provider.lastCheckedAt ? formatDateTime(provider.lastCheckedAt) : undefined}
        >
          {provider.lastCheckedAt
            ? `Loxep checked ${formatRelativeTime(provider.lastCheckedAt)}`
            : 'Loxep has not checked this connection yet'}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * The Gatus heartbeat mirror (loxep-1au §3) — Gatus's own opinion of Loxep's
 * heartbeat endpoint, folded into the Gatus connection's own health `detail`
 * and never a health subject of its own (BINDING RULE 1, enforced in
 * `packages/app/src/fleet-health.ts`). Renders as its OWN card, with the
 * key-mismatch case (a silent no-op before this read existed) called out
 * explicitly, and TWO distinct clocks — Gatus's own evaluation instant and
 * Loxep's read instant — never collapsed into one "last updated".
 */
function HeartbeatMirrorCard({ heartbeat }: { heartbeat: FleetHeartbeatMirrorDto }) {
  return (
    <Card className={cn('h-full', !heartbeat.keyFound && 'border-warning/60')}>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <span className='bg-chart-2/15 text-chart-2 flex size-7 items-center justify-center rounded-full'>
            <Icons.pulse className='size-4' />
          </span>
          <CardTitle className='text-sm font-medium'>Gatus's view of Loxep</CardTitle>
        </div>
        <CardDescription>
          {heartbeat.connectionName} · heartbeat key "{heartbeat.configuredKey}"
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {!heartbeat.keyFound ? (
          <Alert variant='warning'>
            <Icons.warning />
            <AlertTitle>Gatus does not recognize this key</AlertTitle>
            <AlertDescription>
              Loxep has been pushing heartbeats to a key this Gatus instance has never seen — the
              push has been landing nowhere. Gatus replaces space / _ , . # + &amp; with "-" in both
              halves of the endpoint key before joining them; check the configured key on Settings →
              Application against Gatus's own group and name.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <p className='text-sm font-medium'>
              {heartbeat.gatusSuccess === null
                ? 'Gatus has not evaluated this endpoint yet.'
                : heartbeat.gatusSuccess
                  ? 'Gatus reports the heartbeat healthy.'
                  : 'Gatus reports the heartbeat failing.'}
              {heartbeat.uptime24h !== null && (
                <span className='text-muted-foreground font-normal'>
                  {' '}
                  · {formatRate(heartbeat.uptime24h * 100)} 24h uptime
                </span>
              )}
            </p>
            <p className='text-muted-foreground text-xs'>
              {heartbeat.gatusObservedAt
                ? `Gatus evaluated ${formatRelativeTime(heartbeat.gatusObservedAt)}`
                : 'Gatus reported no evaluation timestamp'}
              {' · '}
              Loxep read {formatRelativeTime(heartbeat.checkedAt)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FleetSignalsBand({ signals }: { signals: FleetSignalsDto }) {
  // `signals.providers` already arrives in `FLEET_PROVIDERS` order —
  // `computeFleetSignals` maps over that fixed array — so filtering here
  // preserves it without re-sorting.
  const activeProviders = signals.providers.filter((provider) => provider.connectionCount > 0);

  if (activeProviders.length === 0 && signals.heartbeat === null) {
    return (
      <Card>
        <CardContent>
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.radar />
              </EmptyMedia>
              <EmptyTitle>No fleet tools connected yet</EmptyTitle>
              <EmptyDescription>
                Connect Beszel, Dockhand, Gatus, Tailscale, or Termix on Settings → Connections to
                see fleet signals here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <div>
        <h2 className='text-lg font-semibold tracking-tight'>Fleet signals</h2>
        <p className='text-muted-foreground text-sm'>
          What each connected fleet tool's own read currently shows — never a merged verdict.
        </p>
      </div>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3'>
        {activeProviders.map((provider) => (
          <ProviderTile key={provider.provider} provider={provider} />
        ))}
        {signals.heartbeat && <HeartbeatMirrorCard heartbeat={signals.heartbeat} />}
      </div>
    </div>
  );
}
