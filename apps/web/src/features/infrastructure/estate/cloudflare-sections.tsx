import * as React from 'react';
import CloudflareZonesSection from '@/features/infrastructure/components/cloudflare-estate/zones-section';
import CloudflareRecordsSection from '@/features/infrastructure/components/cloudflare-estate/records-section';
import type { CloudflareEstateZoneDto } from '@/server/cloudflare-estate-functions';

/**
 * The Cloudflare estate browser's (loxep-47o.2) sections, mounted through
 * the estate shell's provider→sections registry
 * (`features/infrastructure/estate/section-registry.tsx`). Master-detail,
 * ONE zone at a time (Rule P6): selecting a zone mounts
 * `CloudflareRecordsSection` for that zone alone; selecting a different one
 * unmounts the previous drill-in before mounting the next — there is
 * structurally never more than one zone's records query in flight, which is
 * what keeps this page inside Rule P7's per-drill-in budget regardless of
 * how many zones an operator clicks through in one session.
 */
export default function CloudflareEstateSections({ connectionId }: { connectionId: string }) {
  const [selectedZone, setSelectedZone] = React.useState<CloudflareEstateZoneDto | null>(null);

  return (
    <div className='flex flex-col gap-4'>
      <CloudflareZonesSection
        connectionId={connectionId}
        selectedZoneId={selectedZone?.externalZoneId ?? null}
        onViewRecords={(zone) =>
          setSelectedZone((current) =>
            current?.externalZoneId === zone.externalZoneId ? null : zone
          )
        }
      />
      {selectedZone !== null && (
        <CloudflareRecordsSection
          connectionId={connectionId}
          externalZoneId={selectedZone.externalZoneId}
          zoneName={selectedZone.name}
        />
      )}
    </div>
  );
}
