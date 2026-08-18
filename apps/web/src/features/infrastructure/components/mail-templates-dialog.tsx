import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { mailboxTemplatesQuery } from '@/features/infrastructure/api/queries';
import type { MailboxTemplateDto } from '@/server/infrastructure-functions';

function TemplateCard({ template }: { template: MailboxTemplateDto }) {
  return (
    <div className='flex flex-col gap-2 rounded-md border p-3'>
      <div className='flex items-center gap-2'>
        <span className='text-sm font-medium'>{template.name}</span>
        {template.isDefault && <Badge variant='outline'>default</Badge>}
      </div>
      {template.entries.length === 0 ? (
        <p className='text-muted-foreground text-sm'>
          No entries — applying this template creates nothing.
        </p>
      ) : (
        <ul className='flex flex-col gap-1'>
          {template.entries.map((entry) => (
            <li key={entry.id} className='font-mono text-sm'>
              <Badge variant='secondary' className='mr-2'>
                {entry.kind}
              </Badge>
              {entry.localPart}
              {entry.forwardTo && (
                <span className='text-muted-foreground'> → {entry.forwardTo}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Read-only view of `mailbox_templates` (loxep-4xo) — what {@link
 * applyDefaultMailboxTemplate} on `mail-panel.tsx` actually applies, which
 * nobody could see before this bead (`createMailboxTemplatesService` was
 * exported by `@loxep/infrastructure` but never constructed in `admin.ts`).
 * List: name, default flag, and the mailboxes/rules each one would create —
 * exactly what the bead asked this surface to show at minimum. Authoring a
 * template is NOT built here: `MailboxTemplatesService.create` takes a whole
 * template (name + entries) in one call, but a legible multi-entry editor
 * (add/remove rows, per-entry kind/forwardTo validation, `isDefault`
 * exclusivity) is a real form on its own, not a trivial extension of this
 * read — left for a follow-up (PROVISIONAL).
 */
export default function MailTemplatesDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: templates, isPending } = useQuery({
    ...mailboxTemplatesQuery,
    enabled: open
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Mailbox templates</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Read-only. Applying a template MERGES its entries into a domain — it never removes an
            address the template does not mention.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {isPending ? (
          <div className='flex flex-col gap-2'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-16 w-full' />
          </div>
        ) : templates === undefined || templates.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.notification />
              </EmptyMedia>
              <EmptyTitle>No templates yet</EmptyTitle>
              <EmptyDescription>
                No mailbox template has been authored. "Apply default template" has nothing to apply
                until one exists.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className='flex flex-col gap-3'>
            {templates.map((template) => (
              <TemplateCard key={template.id} template={template} />
            ))}
          </div>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
