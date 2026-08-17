/**
 * Provider slug -> brand mark (loxep-2xk, ui-overhaul-2026-design.md §5,
 * rule I1). `PROVIDER_BRAND_ICONS` maps every `IntegrationServiceId` to a
 * `simple-icons` icon object, or `null` when `simple-icons@16.28.0` carries
 * no mark for that provider — `null` is explicit and total (every id is a
 * key), never an absent property standing in for "not checked yet".
 * `PROVIDER_BRAND_ICON_FALLBACKS` names the second link in `BrandIcon`'s
 * fallback chain for the providers with no mark.
 *
 * Lives in `src/config` (matching `workspaces.ts`/`site.ts`'s cross-cutting
 * typed-constant home) rather than beside `integrations-catalog.ts`: this
 * module imports `simple-icons`'s per-icon named exports plus a couple of
 * `@tabler/icons-react` components, and `integrations-catalog.ts` is a
 * type/logic module read broadly (the catalog grid, the connections table,
 * every estate page) by code that has no business pulling icon-library
 * weight along for a provider id it only needs as a string key. Splitting
 * this out means only the surfaces that actually render `BrandIcon` pay for
 * that weight, and the dependency is one-directional (this file imports
 * `IntegrationServiceId` FROM the catalog for its key type; the catalog
 * imports nothing back) so there is no circular-import risk either way.
 */
import {
  siCloudflare,
  siEbay,
  siEtsy,
  siInvoiceninja,
  siMedusa,
  siNtfy,
  siPangolin,
  siTailscale,
  siWoocommerce
} from 'simple-icons';
import { IconContainer, IconGuitarPick, IconMail } from '@tabler/icons-react';
import { Icons, type Icon } from '@/components/icons';
import type { IntegrationServiceId } from '@/features/settings/integrations-catalog';
import type { BrandMark } from '@/components/ui/brand-icon';

/**
 * Verified against the installed `simple-icons@16.28.0` package on
 * 2026-08-17 by checking `node_modules/simple-icons`'s actual named exports
 * and `icons/` directory — not assumed from memory (Implementation
 * Contract's dependency-verification rule). Nine providers carry a real
 * mark: eBay, Etsy, WooCommerce, Medusa, Invoice Ninja, Cloudflare,
 * Tailscale, Pangolin, ntfy. Six carry none — exactly the six
 * ui-overhaul-2026-design.md §5 predicted ("Beszel/Dockhand/Termix/
 * Purelymail are likely absent — verify at implementation"), plus Reverb and
 * Gatus, which the same sentence flagged with a "(?)": Reverb, Purelymail,
 * Termix, Gatus, Beszel, Dockhand.
 *
 * Each present mark's `.title` was cross-checked against the provider it is
 * being used for (not just the slug) to rule out a same-named but unrelated
 * brand — e.g. `simple-icons`' `siMedusa` is medusajs.com's own logo
 * (`source` points at the medusajs/medusa GitHub repo), not an unrelated
 * "Medusa" brand.
 */
export const PROVIDER_BRAND_ICONS: Record<IntegrationServiceId, BrandMark | null> = {
  ebay: siEbay,
  etsy: siEtsy,
  reverb: null,
  woocommerce: siWoocommerce,
  medusa: siMedusa,
  invoiceninja: siInvoiceninja,
  cloudflare: siCloudflare,
  purelymail: null,
  tailscale: siTailscale,
  termix: null,
  gatus: null,
  beszel: null,
  dockhand: null,
  pangolin: siPangolin,
  ntfy: siNtfy
};

/**
 * The fallback chain's second link (rule I1) for the six providers above
 * with no `simple-icons` mark — `BrandIcon` renders this when `mark` is
 * `null`, before falling back further to an initial-letter tile.
 *
 * `packages/domain`'s `FLEET_TOOL_REGISTRY` (read-only from `apps/web` —
 * Implementation Contract) already names a semantic icon HINT for four of
 * these six (`gatus: "pulse"`, `beszel: "radar"`, `dockhand: "container"`,
 * `termix: "laptop"`) — that field is documented there as "a short semantic
 * hint for the rendering layer to map onto whatever icon set it has ...
 * never a literal icon-component reference", so this map is where each hint
 * actually becomes one: `Icons.pulse`/`Icons.radar`/`Icons.laptop` are the
 * exact Tabler components `components/icons.tsx` already wires to those same
 * hint strings elsewhere, and `IconContainer` (Tabler, not yet a key in the
 * shared `Icons` map) fills the one hint that map doesn't carry today.
 *
 * Reverb (a musical-gear marketplace) and Purelymail (mail) are not fleet
 * tools, so `FLEET_TOOL_REGISTRY` says nothing about either — a guitar pick
 * and an envelope are this registry's own best-effort choice, made here for
 * the first time, not derived from any other file. PROVISIONAL in the same
 * sense the design doc marks its own fallback rule provisional: a product-
 * feel call, not a binding one.
 */
export const PROVIDER_BRAND_ICON_FALLBACKS: Partial<Record<IntegrationServiceId, Icon>> = {
  reverb: IconGuitarPick,
  purelymail: IconMail,
  termix: Icons.laptop,
  gatus: Icons.pulse,
  beszel: Icons.radar,
  dockhand: IconContainer
};
