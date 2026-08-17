import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BrandIcon } from '@/components/ui/brand-icon';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import {
  CONNECTION_STATUS_LABELS,
  PROVIDER_WRITE_POLICY_TIER_LABELS
} from '@/features/settings/constants';
import { integrationServiceForProvider } from '@/features/settings/integrations-catalog';
import { PROVIDER_BRAND_ICON_FALLBACKS, PROVIDER_BRAND_ICONS } from '@/config/provider-brand-icons';
import { formatRelativeTime } from '@/lib/format';
import type { EstateConnectionSummaryDto } from '@/server/estate-functions';
import type { ConnectionStatus } from '@loxep/domain';

const CONNECTION_STATUS_TONE = {
  active: 'success',
  disabled: 'warning',
  error: 'destructive',
  archived: 'outline'
} as const satisfies Record<ConnectionStatus, Tone>;

const WRITE_POLICY_TIER_TONE = {
  read_only: 'outline',
  additive: 'success',
  access_affecting: 'warning',
  lockout_class: 'destructive'
} as const;

/**
 * The estate page's connection-identity block (Estate Browsers Design §2.2's
 * header row): connection name, provider, non-secret account identity,
 * connection health WITH ITS OWN CLOCK (never the page's own render time —
 * the health facts come from `connections.last_success_at`/`last_error_at`,
 * a Loxep-side fact distinct from any section's `readAt`), and the
 * write-policy tier badge — or "not enforced for this provider" when the
 * provider is absent from `WRITE_POLICY_ENFORCED_PROVIDERS`.
 */
export function EstateHeader({ summary }: { summary: EstateConnectionSummaryDto }) {
  const service = integrationServiceForProvider(summary.provider);
  const identity = summary.externalAccountName ?? summary.externalAccountId;
  const latestAt =
    summary.lastErrorAt !== null &&
    (summary.lastSuccessAt === null ||
      new Date(summary.lastErrorAt).getTime() > new Date(summary.lastSuccessAt).getTime())
      ? summary.lastErrorAt
      : summary.lastSuccessAt;
  const latestIsError = latestAt !== null && latestAt === summary.lastErrorAt;

  return (
    <Card>
      <CardHeader>
        <div className='flex flex-wrap items-center gap-2'>
          {service && (
            <BrandIcon
              mark={PROVIDER_BRAND_ICONS[service.id]}
              fallback={PROVIDER_BRAND_ICON_FALLBACKS[service.id]}
              name={service.name}
              size={24}
            />
          )}
          <CardTitle className='text-base'>{summary.name}</CardTitle>
          <Badge variant='secondary'>{service?.name ?? summary.provider}</Badge>
          <ToneBadge tone={CONNECTION_STATUS_TONE[summary.status]}>
            {CONNECTION_STATUS_LABELS[summary.status]}
          </ToneBadge>
          {summary.writePolicy.enforced && summary.writePolicy.tier !== null ? (
            <ToneBadge tone={WRITE_POLICY_TIER_TONE[summary.writePolicy.tier]}>
              {PROVIDER_WRITE_POLICY_TIER_LABELS[summary.writePolicy.tier]}
            </ToneBadge>
          ) : (
            <span className='text-muted-foreground text-xs'>Write policy not enforced here</span>
          )}
        </div>
        <CardDescription>
          {identity !== null && identity !== undefined && <>{identity} · </>}
          {latestAt === null
            ? 'No connection activity recorded yet.'
            : latestIsError
              ? `Last error ${formatRelativeTime(latestAt)}`
              : `Last successful contact ${formatRelativeTime(latestAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className='text-muted-foreground text-sm'>
        Sections below are read live from {service?.name ?? summary.provider} — nothing here is ever
        cached, scheduled, or stored.
      </CardContent>
    </Card>
  );
}
