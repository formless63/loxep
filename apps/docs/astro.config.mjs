import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://formless63.github.io',
  base: '/loxep',
  integrations: [
    starlight({
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
          label: 'Product',
          items: [
            { label: 'Master Domain Map', slug: 'product/master-domain-map' },
            { label: 'Workspaces & Navigation', slug: 'product/workspaces' },
            { label: 'Roadmap', slug: 'product/roadmap' },
            { label: 'Companion Services', slug: 'product/companion-services' },
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
          ],
        },
        {
          label: 'Development',
          items: [
            { label: 'Implementation Contract', slug: 'development/implementation-contract' },
            { label: 'Dependency & Version Policy', slug: 'development/dependency-policy' },
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
