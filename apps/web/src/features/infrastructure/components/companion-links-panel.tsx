import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import type { CompanionLinkDto } from '@/server/infrastructure-functions';

/**
 * Read-only: `external_resources`/`resource_links` for this hosting target.
 * Loxep LINKS companion tooling (metrics, uptime, container management) —
 * it never reimplements it. Adding a link is a later milestone's surface;
 * this panel renders whatever already exists.
 */
export default function CompanionLinksPanel({ links }: { links: CompanionLinkDto[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>Companion tools</CardTitle>
        <CardDescription>
          Metrics, uptime, and container management — linked, never reimplemented.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {links.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.externalLink />
              </EmptyMedia>
              <EmptyTitle>No companion tool linked yet</EmptyTitle>
              <EmptyDescription>
                Nothing here links a monitoring or management dashboard to this host.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className='flex flex-col gap-2'>
            {links.map((link) => (
              <li key={link.id}>
                <a
                  href={link.url}
                  target='_blank'
                  rel='noreferrer'
                  className='flex items-center justify-between gap-2 rounded-md border px-3 py-2 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring'
                >
                  <span>
                    <span className='font-medium'>{link.title ?? link.provider}</span>
                    <span className='text-muted-foreground'> · {link.externalType}</span>
                  </span>
                  <Icons.externalLink className='text-muted-foreground' />
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
