import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import ProxyResourceRow, { ProxyResourceEmptyState } from './proxy-resource-row';
import type { ProxyResourceChainDto } from '@/server/infrastructure-functions';

/**
 * The domain-detail panel for the Pangolin chain design's milestone 2
 * (loxep-acj.2): "domain -> Cloudflare record -> Pangolin resource -> hosting
 * target". The first two links are already rendered above this panel (the
 * "Desired records" list on `/infrastructure/domains/$name`, including any
 * `owner='proxy_resource'` A/AAAA rows) — this panel is the NEW third link.
 *
 * Read-only. Milestone 2 is CHECK MODE ONLY and ships no proxy-resource
 * authoring UI at all — declaring intent is a later milestone's surface.
 */
export default function ProxyChainPanel({ resources }: { resources: ProxyResourceChainDto[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Proxy resources</CardTitle>
        <CardDescription>
          The Pangolin resource(s) fronting this domain, and the hosting target each points at.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {resources.length === 0 ? (
          <ProxyResourceEmptyState
            title='No proxy resource declared'
            description='This domain has no declared Pangolin resource yet.'
          />
        ) : (
          <ul className='flex flex-col gap-3'>
            {resources.map((resource) => (
              <ProxyResourceRow
                key={resource.id}
                resource={resource}
                linkTo={{
                  to: '/infrastructure/fleet/$name',
                  params: { name: resource.hostingTargetName },
                  label: resource.hostingTargetName
                }}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
