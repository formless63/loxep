import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { hostingTargetQuery } from '@/features/infrastructure/api/queries';
import AddCompanionLinkDialog from '@/features/infrastructure/components/add-companion-link-dialog';
import { removeCompanionLink } from '@/server/infrastructure-functions';
import type { CompanionLinkDto } from '@/server/infrastructure-functions';

function RemoveLinkButton({
  link,
  hostingTargetName
}: {
  link: CompanionLinkDto;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      removeCompanionLink({
        data: {
          externalResourceId: link.id,
          hostingTargetId: link.resourceId,
          purpose: link.purpose
        }
      }),
    onSuccess: async () => {
      toast.success('Companion link removed');
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
    },
    onError: (error) => toastError(error, 'Failed to remove companion link')
  });

  return (
    <Button
      size='icon'
      variant='ghost'
      className='text-muted-foreground hover:text-destructive'
      disabled={mutation.isPending}
      onClick={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
      aria-label={`Remove ${link.title ?? link.provider} link`}
    >
      <Icons.trash />
    </Button>
  );
}

/**
 * `external_resources`/`resource_links` for this hosting target, via
 * `@loxep/domain`'s generic companion-link service (loxep-v5r.3). Loxep
 * LINKS companion tooling (metrics, uptime, container management) — it
 * never reimplements it. "Add tool link" writes a deep link only; no
 * credential, no adapter, no vendor cooperation.
 */
export default function CompanionLinksPanel({
  hostingTargetId,
  hostingTargetName,
  links
}: {
  hostingTargetId: string;
  hostingTargetName: string;
  links: CompanionLinkDto[];
}) {
  const [addOpen, setAddOpen] = React.useState(false);

  const addButton = (
    <Button size='sm' onClick={() => setAddOpen(true)}>
      <Icons.add />
      Add tool link
    </Button>
  );

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
            <EmptyContent>{addButton}</EmptyContent>
          </Empty>
        ) : (
          <div className='flex flex-col gap-3'>
            <ul className='flex flex-col gap-2'>
              {links.map((link) => (
                <li
                  key={`${link.id}-${link.purpose}`}
                  className='flex items-center justify-between gap-2 rounded-md border px-3 py-2'
                >
                  <a
                    href={link.url}
                    target='_blank'
                    rel='noreferrer'
                    className='flex min-w-0 flex-1 flex-col outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
                  >
                    <span className='flex items-center gap-2'>
                      <span className='font-medium'>{link.title ?? link.provider}</span>
                      <Icons.externalLink className='text-muted-foreground size-3.5 shrink-0' />
                    </span>
                    <span className='text-muted-foreground text-sm'>
                      {link.provider} · {link.externalType} · {link.purpose} · linked{' '}
                      {formatDateTime(link.createdAt)}
                    </span>
                  </a>
                  <RemoveLinkButton link={link} hostingTargetName={hostingTargetName} />
                </li>
              ))}
            </ul>
            <div>{addButton}</div>
          </div>
        )}
      </CardContent>
      {addOpen && (
        <AddCompanionLinkDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          hostingTargetId={hostingTargetId}
          hostingTargetName={hostingTargetName}
        />
      )}
    </Card>
  );
}
