import * as React from 'react';
import DockhandEnvironmentsSection from '@/features/infrastructure/components/dockhand-estate/environments-section';
import DockhandEnvironmentDetailSection from '@/features/infrastructure/components/dockhand-estate/environment-detail-section';
import type { DockhandEstateEnvironmentDto } from '@/server/dockhand-estate-functions';

/**
 * The Dockhand estate browser's (loxep-47o.4, READ-ONLY) sections, mounted
 * through the estate shell's provider→sections registry
 * (`features/infrastructure/estate/section-registry.tsx`). Master-detail,
 * ONE environment at a time (Rule P6) — exactly `cloudflare-sections.tsx`'s
 * zones/records shape: selecting an environment mounts the
 * containers/stacks drill-in for that environment alone; selecting a
 * different one unmounts the previous drill-in first, so there is never more
 * than one environment's containers/stacks query in flight — the login cost
 * (`DOCKHAND_LOGIN_COST`, 4 of an 8-token capacity) is why this page can
 * only ever afford one drill-in in flight, not a UX nicety.
 */
export default function DockhandEstateSections({ connectionId }: { connectionId: string }) {
  const [selectedEnvironment, setSelectedEnvironment] =
    React.useState<DockhandEstateEnvironmentDto | null>(null);

  return (
    <div className='flex flex-col gap-4'>
      <DockhandEnvironmentsSection
        connectionId={connectionId}
        selectedExternalHostId={selectedEnvironment?.externalHostId ?? null}
        onViewContainers={(environment) =>
          setSelectedEnvironment((current) =>
            current?.externalHostId === environment.externalHostId ? null : environment
          )
        }
      />
      {selectedEnvironment !== null && (
        <DockhandEnvironmentDetailSection
          connectionId={connectionId}
          externalHostId={selectedEnvironment.externalHostId}
          environmentName={selectedEnvironment.name}
        />
      )}
    </div>
  );
}
