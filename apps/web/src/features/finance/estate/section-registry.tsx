import type { ComponentType } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import InvoiceNinjaEstateSections from './invoiceninja-sections';

/**
 * The finance workspace's provider→sections registry (loxep-47o.8) — the
 * `/finance` sibling of `features/infrastructure/estate/
 * section-registry.tsx`, the heavier counterpart to
 * `@/features/estate/provider-registry`'s lightweight metadata map. This is
 * the FIRST such registry built outside `/infrastructure`: it proves Rule
 * P1's workspace parameter is real, not merely documented, since nothing
 * here or in `invoiceninja-sections.tsx`/`invoiceninja-estate-functions.ts`
 * imports anything from `features/infrastructure/**` or
 * `server/*-estate-functions.ts` for another provider — the shared surface
 * is exactly `features/estate/**` (types, error taxonomy, section/header/page
 * components, provider-registry) and nothing else.
 *
 * Imported ONLY by `/finance/estate/$connectionId`'s route file, never by
 * `/settings/connections` or the finance estate index (which need only the
 * lightweight metadata registry to build a link) — same import-cost
 * discipline `INFRASTRUCTURE_ESTATE_SECTION_REGISTRY`'s own doc states.
 */
export interface FinanceEstateSectionEntry {
  Sections: ComponentType<{ connectionId: string }>;
  prefetch?: (queryClient: QueryClient, connectionId: string) => Promise<unknown>;
}

export const FINANCE_ESTATE_SECTION_REGISTRY: Record<string, FinanceEstateSectionEntry> = {
  // No `prefetch`: both sections use a plain `useQuery` (pending/error
  // branches), not `useSuspenseQuery` — matching the Cloudflare/Purelymail/
  // Wave 2 precedent, since each section's own `EstateSection` renders its
  // own pending/error state independently (Rule P4).
  invoiceninja: {
    Sections: InvoiceNinjaEstateSections
  }
};
