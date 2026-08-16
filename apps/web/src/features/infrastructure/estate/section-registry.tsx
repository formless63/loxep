import type { ComponentType } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { pangolinEstateOverviewQuery } from '@/features/infrastructure/api/queries';
import PangolinEstateSections from './pangolin-sections';
import PurelymailEstateSections from './purelymail-sections';
import CloudflareEstateSections from './cloudflare-sections';

/**
 * The infrastructure workspace's provider→sections registry (loxep-47o.1),
 * the heavier sibling of `@/features/estate/provider-registry`'s metadata
 * map — this one carries the actual `Sections` component per provider, so it
 * is imported ONLY by `/infrastructure/estate/$connectionId`'s route file,
 * never by `/settings/connections` or the estate index (which need only the
 * lightweight metadata registry to build a link).
 *
 * A future `/finance/estate/$connectionId` (Invoice Ninja, `loxep-47o.8`)
 * gets its own sibling file under `features/finance/estate/` — Rule P16
 * forbids one workspace's registry from growing another workspace's
 * provider.
 */
export interface InfrastructureEstateSectionEntry {
  Sections: ComponentType<{ connectionId: string }>;
  /** Optional route-loader prefetch, mirroring `pangolin-estate-functions.ts`' own suspense-preload precedent — keeps the "no loading flash on navigate" UX the pre-shell route had. */
  prefetch?: (queryClient: QueryClient, connectionId: string) => Promise<unknown>;
}

export const INFRASTRUCTURE_ESTATE_SECTION_REGISTRY: Record<
  string,
  InfrastructureEstateSectionEntry
> = {
  pangolin: {
    Sections: PangolinEstateSections,
    prefetch: (queryClient, connectionId) =>
      queryClient.ensureQueryData(pangolinEstateOverviewQuery(connectionId))
  },
  // No `prefetch`: like Cloudflare below, Purelymail's three sections each
  // use a plain `useQuery` (pending/error branches, Dockhand-containers-panel
  // precedent), not `useSuspenseQuery` — there is no loader-suspense
  // boundary to preload for, and each section's own `EstateSection` renders
  // its own pending/error state independently (Rule P4).
  purelymail: {
    Sections: PurelymailEstateSections
  },
  cloudflare: {
    Sections: CloudflareEstateSections
  }
};
