/**
 * The estate-browser program's provider→workspace registry (loxep-47o.1) —
 * "code, not schema, keyed by provider", the same shape `FLEET_TOOL_REGISTRY`
 * and `integrations-catalog.ts` already use (Estate Browsers Design §2.1).
 *
 * This file is metadata ONLY (no React import) so it can be imported cheaply
 * from `/settings/connections`' row action and the `/infrastructure/estate`
 * index without pulling every provider's section components into that
 * bundle. The heavier per-workspace registry that maps a provider to its
 * actual `Sections` component lives beside its route —
 * `features/infrastructure/estate/section-registry.tsx` for every
 * Infrastructure-category provider, `features/finance/estate/
 * section-registry.tsx` (loxep-47o.8) for Invoice Ninja. Rule P16 keeps these
 * two registries from ever growing each other's provider.
 *
 * Rule P1: the route is `/<workspace>/estate/$connectionId` — the connection
 * id is the only param, and the provider is read from the connection row,
 * never encoded in the path. `estateHref` below is the one place that turns
 * a `(provider, connectionId)` pair into that route.
 */

/** A provider this program has SHIPPED an estate page for. Grows one entry per wave. */
export interface EstateProviderRegistryEntry {
  /** Matches a `workspaces.ts` id — which workspace's `/estate/$connectionId` route this provider renders under. */
  workspace: string;
  /** Short, human label for nav/links — e.g. "Pangolin estate". */
  label: string;
}

export const ESTATE_PROVIDER_REGISTRY: Record<string, EstateProviderRegistryEntry> = {
  pangolin: { workspace: 'infrastructure', label: 'Pangolin estate' },
  cloudflare: { workspace: 'infrastructure', label: 'Cloudflare estate' },
  purelymail: { workspace: 'infrastructure', label: 'Purelymail estate' },
  tailscale: { workspace: 'infrastructure', label: 'Tailscale estate' },
  beszel: { workspace: 'infrastructure', label: 'Beszel estate' },
  termix: { workspace: 'infrastructure', label: 'Termix estate' },
  dockhand: { workspace: 'infrastructure', label: 'Dockhand estate' },
  gatus: { workspace: 'infrastructure', label: 'Gatus estate' },
  // Wave 3 (loxep-47o.8) — the FIRST estate page outside `/infrastructure`,
  // which is what actually proves Rule P1's workspace parameter: the
  // workspace is a property of the PROVIDER (via `integrations-catalog.ts`'s
  // `category: 'Billing'`), never of the page or the route file.
  invoiceninja: { workspace: 'finance', label: 'Invoice Ninja estate' }
};

/**
 * Every provider the Estate Browsers Design (§1) rules INTO the
 * "Infrastructure-category" — including the ones without a shipped estate
 * page yet (waves 2/3 land later; the `/infrastructure/estate` index lists
 * them all today per Rule N2, with a working link only once one exists).
 * Invoice Ninja is deliberately excluded — it is a `/finance` estate.
 */
export const INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS = new Set([
  'cloudflare',
  'purelymail',
  'pangolin',
  'dockhand',
  'beszel',
  'tailscale',
  'termix',
  'gatus'
]);

/**
 * The `/finance` sibling of {@link INFRASTRUCTURE_ESTATE_CATEGORY_PROVIDERS}
 * (Rule N2's "`/finance` gains the equivalent when Invoice Ninja's wave
 * lands") — every provider ruled INTO the finance-category estate index,
 * `integrations-catalog.ts`'s `category: 'Billing'` providers with a shipped
 * estate page. One entry today; the set exists (rather than inlining a
 * single-provider check at the index route) so a future finance-category
 * provider needs no index-route change, matching the infrastructure set's
 * own shape exactly.
 */
export const FINANCE_ESTATE_CATEGORY_PROVIDERS = new Set(['invoiceninja']);

/** Whether this provider has a SHIPPED estate page (an entry in the registry above). */
export function hasEstatePage(provider: string): boolean {
  return provider in ESTATE_PROVIDER_REGISTRY;
}

/**
 * The route params for this provider's estate page, or `null` when none
 * exists — the single place `/settings/connections`' "Open estate" row
 * action and the `/infrastructure/estate` index both consult, so neither can
 * ever link somewhere a route doesn't exist.
 */
export function estateHref(
  provider: string,
  connectionId: string
): { to: string; params: { connectionId: string } } | null {
  const entry = ESTATE_PROVIDER_REGISTRY[provider];
  if (entry === undefined) return null;
  return { to: `/${entry.workspace}/estate/$connectionId`, params: { connectionId } };
}
