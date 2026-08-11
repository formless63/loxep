/**
 * Central site metadata used for SEO, Open Graph / Twitter cards, the sitemap,
 * and the `llms.txt` AEO file.
 *
 * `url` is the canonical production origin — update it to your deployed domain.
 * It is used to build absolute URLs for og:image / twitter:image and the sitemap.
 */
export const siteConfig = {
  name: 'Loxep',
  // Canonical production URL — change this to your deployed domain.
  url: 'https://loxep.com',
  description:
    'Loxep is an open-source, self-hosted platform for marketplace intelligence, multichannel commerce operations, services, inventory, billing, and financial visibility.',
  // Path (relative to the site root) of the Open Graph / Twitter share image.
  ogImage: '/favicon.svg',
  keywords: [
    'Loxep',
    'marketplace intelligence',
    'commerce operations',
    'self-hosted',
    'open source',
    'eBay monitoring',
    'listing observation',
    'inventory',
    'multichannel commerce'
  ],
  links: {
    github: 'https://github.com/formless63/loxep',
    docs: 'https://formless63.github.io/loxep/'
  }
} as const;

export type SiteConfig = typeof siteConfig;
