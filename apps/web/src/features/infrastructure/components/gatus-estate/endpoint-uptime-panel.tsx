import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { EstateSection } from '@/features/estate/components/estate-section';
import { gatusEstateEndpointUptimeQuery } from '@/features/infrastructure/api/queries';
import type { GatusEstateUptimeDuration } from '@/server/gatus-estate-functions';

const DURATION_OPTIONS: { value: GatusEstateUptimeDuration; label: string }[] = [
  { value: '1h', label: 'Last hour' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' }
];

/**
 * The Gatus estate's per-endpoint uptime DRILL-IN (Rule P6, design §3.7) —
 * `endpointUptime(key, duration)`, the one read that works in EVERY Gatus
 * auth posture, since the route sits on Gatus's permanently-unauthenticated
 * group. This is what keeps this drill-in usable when the Endpoints section
 * above it is BLOCKED under OIDC.
 */
export default function GatusEndpointUptimePanel({
  connectionId,
  endpointKey
}: {
  connectionId: string;
  endpointKey: string;
}) {
  const [duration, setDuration] = React.useState<GatusEstateUptimeDuration>('24h');
  const { data, isPending, isError, error, refetch } = useQuery(
    gatusEstateEndpointUptimeQuery(connectionId, endpointKey, duration)
  );

  return (
    <EstateSection
      title={`Uptime — ${endpointKey}`}
      description="Live from Gatus's endpointUptime() — unauthenticated in every posture."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={() => false}
      emptyMessage=''
    >
      {(uptime) => (
        <div className='flex flex-wrap items-center gap-3'>
          <Select
            value={duration}
            onValueChange={(value) => setDuration(value as GatusEstateUptimeDuration)}
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DURATION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className='text-2xl font-semibold tabular-nums'>
            {uptime.uptime === null ? '—' : `${(uptime.uptime * 100).toFixed(2)}%`}
          </span>
        </div>
      )}
    </EstateSection>
  );
}
