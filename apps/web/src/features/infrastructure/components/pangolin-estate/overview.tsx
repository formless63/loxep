import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { formatRelativeTime } from '@/lib/format';
import PangolinEstateResourceCard from './resource-card';
import type { PangolinEstateOverviewDto } from '@/server/pangolin-estate-functions';

function SitesTab({ sites }: { sites: PangolinEstateOverviewDto['sites'] }) {
  if (sites.length === 0) {
    return (
      <Empty className='p-0'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.integrations />
          </EmptyMedia>
          <EmptyTitle>No sites</EmptyTitle>
          <EmptyDescription>This organization has no sites yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className='flex flex-col gap-2'>
      {sites.map((site, index) => (
        <li
          key={site.siteId ?? site.niceId ?? index}
          className='flex flex-wrap items-center justify-between gap-2 rounded-md border p-3'
        >
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-medium'>{site.name ?? site.niceId ?? 'Unnamed site'}</span>
            {site.type && <Badge variant='outline'>{site.type}</Badge>}
            {site.address && (
              <span className='text-muted-foreground font-mono text-sm'>{site.address}</span>
            )}
          </div>
          {site.online ? (
            <Badge variant='success'>online</Badge>
          ) : (
            <Badge variant='secondary'>{site.status ?? 'offline'}</Badge>
          )}
        </li>
      ))}
    </ul>
  );
}

function ResourcesTab({
  connectionId,
  resources
}: {
  connectionId: string;
  resources: PangolinEstateOverviewDto['resources'];
}) {
  if (resources.length === 0) {
    return (
      <Empty className='p-0'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.integrations />
          </EmptyMedia>
          <EmptyTitle>No resources</EmptyTitle>
          <EmptyDescription>This organization has no resources yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className='flex flex-col gap-2'>
      {resources.map((resource, index) => (
        <li key={resource.resourceId ?? resource.niceId ?? index}>
          <PangolinEstateResourceCard connectionId={connectionId} resource={resource} />
        </li>
      ))}
    </ul>
  );
}

function DomainsTab({ domains }: { domains: PangolinEstateOverviewDto['domains'] }) {
  if (domains.length === 0) {
    return (
      <Empty className='p-0'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.integrations />
          </EmptyMedia>
          <EmptyTitle>No org domains</EmptyTitle>
          <EmptyDescription>This organization has no domains registered yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className='flex flex-col gap-2'>
      {domains.map((domain, index) => (
        <li
          key={domain.domainId ?? index}
          className='flex flex-wrap items-center justify-between gap-2 rounded-md border p-3'
        >
          <div className='flex flex-wrap items-center gap-2'>
            <span className='font-mono font-medium'>{domain.baseDomain ?? 'Unnamed domain'}</span>
            {domain.type && <Badge variant='outline'>{domain.type}</Badge>}
            {domain.configManaged && <Badge variant='secondary'>config-managed</Badge>}
          </div>
          <div className='flex items-center gap-2'>
            {domain.verified ? (
              <Badge variant='success'>verified</Badge>
            ) : (
              <Badge variant='secondary'>unverified</Badge>
            )}
            {domain.failed && <Badge variant='destructive'>failed</Badge>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The Pangolin estate browser's (loxep-pq2) whole-page content — Sites,
 * Resources, and Org domains as three tabs over one live read. Every section
 * renders provider-truth verbatim; the shared clock-stamp line at the top
 * covers all three, since they were all read in the same `readAt` moment
 * (the overview handler's three calls run concurrently). `orgId === null`
 * renders as an honest, actionable empty state rather than three separately
 * empty tabs — see the handler's own doc for why nothing can be listed
 * without one.
 */
export default function PangolinEstateOverview({ data }: { data: PangolinEstateOverviewDto }) {
  if (data.orgId === null) {
    return (
      <Alert variant='warning'>
        <Icons.warning />
        <AlertTitle>No organization id configured</AlertTitle>
        <AlertDescription>
          This connection has no resolvable Pangolin organization id, so nothing can be listed — add
          one on <strong>Settings → Connections</strong>, or (for a root-scoped key) confirm which
          organization this connection should read.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{data.connectionName}</CardTitle>
          <CardDescription>
            Organization <span className='font-mono'>{data.orgId}</span> · read just now (
            {formatRelativeTime(data.readAt)}) — live, never stored.
          </CardDescription>
        </CardHeader>
      </Card>

      <Tabs defaultValue='resources'>
        <TabsList>
          <TabsTrigger value='sites'>Sites ({data.sites.length})</TabsTrigger>
          <TabsTrigger value='resources'>Resources ({data.resources.length})</TabsTrigger>
          <TabsTrigger value='domains'>Org domains ({data.domains.length})</TabsTrigger>
        </TabsList>
        <TabsContent value='sites' className='pt-4'>
          <SitesTab sites={data.sites} />
        </TabsContent>
        <TabsContent value='resources' className='pt-4'>
          <ResourcesTab connectionId={data.connectionId} resources={data.resources} />
        </TabsContent>
        <TabsContent value='domains' className='pt-4'>
          <DomainsTab domains={data.domains} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
