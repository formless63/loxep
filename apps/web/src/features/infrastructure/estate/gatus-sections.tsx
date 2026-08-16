import * as React from 'react';
import GatusInstancePanel from '@/features/infrastructure/components/gatus-estate/instance-panel';
import GatusEndpointsSection from '@/features/infrastructure/components/gatus-estate/endpoints-section';
import GatusEndpointUptimePanel from '@/features/infrastructure/components/gatus-estate/endpoint-uptime-panel';
import type { GatusEstateEndpointDto } from '@/server/gatus-estate-functions';

/**
 * The Gatus estate browser's (loxep-47o.5) sections, mounted through the
 * estate shell's provider→sections registry. Instance + Endpoints is the
 * fixed three-call overview (Estate Browsers Design §3.7). The per-endpoint
 * uptime drill-in is master-detail, ONE endpoint at a time (Rule P6) —
 * exactly `cloudflare-sections.tsx`'s zones/records shape.
 */
export default function GatusEstateSections({ connectionId }: { connectionId: string }) {
  const [selectedEndpoint, setSelectedEndpoint] = React.useState<GatusEstateEndpointDto | null>(
    null
  );

  return (
    <div className='flex flex-col gap-4'>
      <GatusInstancePanel connectionId={connectionId} />
      <GatusEndpointsSection
        connectionId={connectionId}
        selectedKey={selectedEndpoint?.key ?? null}
        onViewUptime={(endpoint) =>
          setSelectedEndpoint((current) => (current?.key === endpoint.key ? null : endpoint))
        }
      />
      {selectedEndpoint !== null && (
        <GatusEndpointUptimePanel connectionId={connectionId} endpointKey={selectedEndpoint.key} />
      )}
    </div>
  );
}
