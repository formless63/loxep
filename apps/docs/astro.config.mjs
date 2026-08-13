import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  site: 'https://formless63.github.io',
  base: '/loxep',
  integrations: [
    starlight({
      // Relative links are the project convention (portable across docs
      // renderers); the validator checks that they resolve in the built site.
      plugins: [starlightLinksValidator({ errorOnRelativeLinks: false })],
      title: 'Loxep',
      description: 'Self-hosted marketplace intelligence and business operations.',
      customCss: ['./src/styles/custom.css'],
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 2,
      },
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/formless63/loxep',
        },
      ],
      sidebar: [
        {
          label: 'Overview',
          items: [
            { label: 'Vision', slug: 'overview/vision' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Overview', slug: 'guides' },
            { label: 'Connecting eBay', slug: 'guides/connecting-ebay' },
            { label: 'Connecting Etsy', slug: 'guides/connecting-etsy' },
            { label: 'Connecting Reverb', slug: 'guides/connecting-reverb' },
            { label: 'Connecting WooCommerce', slug: 'guides/connecting-woocommerce' },
            { label: 'Connecting Medusa', slug: 'guides/connecting-medusa' },
            { label: 'Connecting Invoice Ninja', slug: 'guides/connecting-invoice-ninja' },
            { label: 'Connecting Cloudflare', slug: 'guides/connecting-cloudflare' },
            { label: 'Connecting Purelymail', slug: 'guides/connecting-purelymail' },
            { label: 'Connecting Beszel', slug: 'guides/connecting-beszel' },
            { label: 'Connecting Dockhand', slug: 'guides/connecting-dockhand' },
            { label: 'Connecting Tailscale', slug: 'guides/connecting-tailscale' },
            { label: 'Connecting Termix', slug: 'guides/connecting-termix' },
            { label: 'Connecting Gatus', slug: 'guides/connecting-gatus' },
            { label: 'Publishing health to Gatus', slug: 'guides/gatus-health-push' },
          ],
        },
        {
          label: 'Product',
          items: [
            { label: 'Master Domain Map', slug: 'product/master-domain-map' },
            { label: 'Workspaces & Navigation', slug: 'product/workspaces' },
            { label: 'Roadmap', slug: 'product/roadmap' },
            { label: 'Companion Services', slug: 'product/companion-services' },
            { label: 'Weave Audit (2026-08)', slug: 'product/weave-audit-2026-08' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Principles', slug: 'architecture/principles' },
            { label: 'System Overview', slug: 'architecture/system-overview' },
            { label: 'Domain Boundaries', slug: 'architecture/domain-boundaries' },
            { label: 'Configuration & Secrets', slug: 'architecture/configuration-and-secrets' },
            { label: 'Phase 0 Foundation', slug: 'architecture/phase-0-foundation' },
            { label: 'Foundational Data Model', slug: 'architecture/foundational-data-model' },
            { label: 'Foundational Decisions', slug: 'architecture/foundational-decisions' },
            { label: 'Foundation Schema', slug: 'architecture/foundation-schema' },
            { label: 'Commerce Schema Design (Phase 3)', slug: 'architecture/commerce-schema-design' },
            { label: 'Etsy Integration Design', slug: 'architecture/etsy-integration-design' },
            { label: 'Reverb Integration Design', slug: 'architecture/reverb-integration-design' },
            { label: 'Inventory & Acquisition Schema Design (Phase 4)', slug: 'architecture/inventory-schema-design' },
            { label: 'Financial Foundation Schema Design (Phase 5)', slug: 'architecture/financial-schema-design' },
            { label: 'Counterparty, Project, Service & Billing Schema Design (Phase 6)', slug: 'architecture/services-billing-schema-design' },
            { label: 'Infrastructure Control Plane Design (Phase 7)', slug: 'architecture/infrastructure-control-design' },
            { label: 'Fleet Observability Design (Phase 8)', slug: 'architecture/fleet-observability-design' },
            { label: 'Flipping Lifecycle Design (Phase 9)', slug: 'architecture/flipping-lifecycle-design' },
            { label: 'Knowledge & Task Companion Integration Design', slug: 'architecture/knowledge-tasks-integration-design' },
          ],
        },
        {
          label: 'Development',
          items: [
            { label: 'Implementation Contract', slug: 'development/implementation-contract' },
            { label: 'Frontend Standards', slug: 'development/frontend-standards' },
            { label: 'Dependency & Version Policy', slug: 'development/dependency-policy' },
            { label: 'Project Surfaces & Future Sites', slug: 'development/project-surfaces' },
            { label: 'Phase 0 Exit Walkthrough', slug: 'development/phase-0-exit-walkthrough' },
          ],
        },
        {
          label: 'Decisions',
          items: [
            { autogenerate: { directory: 'decisions' } },
          ],
        },
      ],
    }),
  ],
});
