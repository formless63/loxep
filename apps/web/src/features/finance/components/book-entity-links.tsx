import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatDate } from '@/lib/format';
import { bookDetailQuery } from '@/features/finance/api/books-queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import type { BookEntityLinkDto } from '@/server/books-functions';
import { endEntityLink, linkEntity } from '@/server/books-functions';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const linkRoleOptions = [
  { value: 'posting_primary', label: 'Posting primary — this entity’s own activity posts here' },
  { value: 'reporting_only', label: 'Reporting only — a view over activity posted elsewhere' }
];

const linkEntitySchema = z.object({
  economicEntityId: z.string().trim().min(1, 'Pick an entity'),
  linkRole: z.enum(['posting_primary', 'reporting_only']),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  effectiveTo: z.string()
});

type LinkEntityFormValues = z.infer<typeof linkEntitySchema>;

function LinkEntityDialog({
  open,
  onOpenChange,
  accountingBookId
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountingBookId: string;
}) {
  const queryClient = useQueryClient();
  const { data: entities } = useQuery(entitiesQuery);
  const entityOptions = (entities ?? []).map((entity) => ({
    value: entity.id,
    label: entity.name
  }));

  const mutation = useMutation({
    mutationFn: (values: LinkEntityFormValues) =>
      linkEntity({
        data: {
          accountingBookId,
          economicEntityId: values.economicEntityId,
          linkRole: values.linkRole,
          effectiveFrom: values.effectiveFrom,
          effectiveTo: values.effectiveTo.trim() === '' ? null : values.effectiveTo
        }
      }),
    onSuccess: () => {
      toast.success('Entity linked');
      void queryClient.invalidateQueries({ queryKey: bookDetailQuery(accountingBookId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to link entity')
  });

  const form = useAppForm({
    defaultValues: {
      economicEntityId: '',
      linkRole: 'posting_primary',
      effectiveFrom: todayIsoDate(),
      effectiveTo: ''
    } as LinkEntityFormValues,
    validators: { onSubmit: linkEntitySchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Link entity</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A child entity always rolls up into its parent&rsquo;s posting book — the service
            refuses a posting-primary link that would split a parent from a part of itself. Record
            the standalone view as reporting-only instead.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField
              name='economicEntityId'
              children={(field) => (
                <field.SelectField label='Entity' required options={entityOptions} />
              )}
            />
            <form.AppField
              name='linkRole'
              children={(field) => (
                <field.SelectField label='Link role' required options={linkRoleOptions} />
              )}
            />
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='effectiveFrom'
                children={(field) => (
                  <field.TextField label='Effective from' required type='date' />
                )}
              />
              <form.AppField
                name='effectiveTo'
                children={(field) => (
                  <field.TextField
                    label='Effective to'
                    type='date'
                    description='Leave blank for open-ended — the current arrangement.'
                  />
                )}
              />
            </div>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Link entity</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function EndLinkDialog({
  open,
  onOpenChange,
  accountingBookId,
  link
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountingBookId: string;
  link: BookEntityLinkDto;
}) {
  const queryClient = useQueryClient();
  const [effectiveTo, setEffectiveTo] = React.useState(todayIsoDate());

  const mutation = useMutation({
    mutationFn: () => endEntityLink({ data: { bookEntityLinkId: link.id, effectiveTo } }),
    onSuccess: () => {
      toast.success(`${link.entityName}’s link ended`);
      void queryClient.invalidateQueries({ queryKey: bookDetailQuery(accountingBookId).queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to end link')
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>End link for {link.entityName}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            This is how an entity moves books at a date boundary — the link itself is never deleted,
            only closed. Open a new link (in this book or another) starting the day after.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor='end-link-effective-to'>Effective to</FieldLabel>
            <Input
              id='end-link-effective-to'
              type='date'
              value={effectiveTo}
              min={link.effectiveFrom}
              onChange={(event) => setEffectiveTo(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <div className='flex justify-end gap-2'>
          <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant='destructive'
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            End link
          </Button>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function isActiveToday(link: BookEntityLinkDto): boolean {
  const today = todayIsoDate();
  return link.effectiveFrom <= today && (link.effectiveTo === null || link.effectiveTo >= today);
}

export default function BookEntityLinks({
  accountingBookId,
  links
}: {
  accountingBookId: string;
  links: BookEntityLinkDto[];
}) {
  const [linkDialogOpen, setLinkDialogOpen] = React.useState(false);
  const [endingLink, setEndingLink] = React.useState<BookEntityLinkDto | null>(null);

  return (
    <Card>
      <CardHeader className='flex flex-row items-start justify-between gap-2'>
        <div>
          <CardTitle>Entity links</CardTitle>
          <CardDescription>
            Which economic entities post here, and the roll-up they carry. Linking a parent entity
            here covers every child that has no link of its own — that inheritance, not a separate
            ledger, is what &ldquo;included in / part of&rdquo; means for a book.
          </CardDescription>
        </div>
        <Button size='sm' onClick={() => setLinkDialogOpen(true)}>
          <Icons.add />
          Link entity
        </Button>
      </CardHeader>
      <CardContent>
        {links.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.teams />
              </EmptyMedia>
              <EmptyTitle>No entity linked</EmptyTitle>
              <EmptyDescription>
                Without a link, nothing routes here except through the installation default book,
                when one is configured.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Effective from</TableHead>
                <TableHead>Effective to</TableHead>
                <TableHead className='text-right'>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((link) => {
                const active = isActiveToday(link);
                return (
                  <TableRow key={link.id}>
                    <TableCell className='font-medium'>
                      {link.entityName}
                      {link.dimensionLabel && (
                        <span className='text-muted-foreground ml-1 text-xs'>
                          ({link.dimensionLabel})
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={link.linkRole === 'posting_primary' ? 'default' : 'outline'}>
                        {link.linkRole === 'posting_primary' ? 'Posting primary' : 'Reporting only'}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {formatDate(link.effectiveFrom)}
                    </TableCell>
                    <TableCell className='text-muted-foreground'>
                      {link.effectiveTo ? formatDate(link.effectiveTo) : 'Open-ended'}
                    </TableCell>
                    <TableCell className='text-right'>
                      {active && link.effectiveTo === null && (
                        <Button size='sm' variant='outline' onClick={() => setEndingLink(link)}>
                          End link
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <LinkEntityDialog
        open={linkDialogOpen}
        onOpenChange={setLinkDialogOpen}
        accountingBookId={accountingBookId}
      />
      {endingLink && (
        <EndLinkDialog
          open={endingLink !== null}
          onOpenChange={(next) => {
            if (!next) setEndingLink(null);
          }}
          accountingBookId={accountingBookId}
          link={endingLink}
        />
      )}
    </Card>
  );
}
