import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://formless63.github.io',
  base: '/loxep',
  integrations: [
    starlight({
      title: 'Loxep',
      description: 'Self-hosted marketplace intelligence and business operations.',
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
            { label: 'Roadmap', slug: 'product/roadmap' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Principles', slug: 'architecture/principles' },
            { label: 'System Overview', slug: 'architecture/system-overview' },
            { label: 'Domain Boundaries', slug: 'architecture/domain-boundaries' },
            { label: 'Foundational Data Model', slug: 'architecture/foundational-data-model' },
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
