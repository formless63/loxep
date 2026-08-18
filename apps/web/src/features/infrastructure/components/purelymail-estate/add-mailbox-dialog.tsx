import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  purelymailEstateDomainsQuery,
  purelymailEstateMailboxesQuery
} from '@/features/infrastructure/api/queries';
import { addPurelymailMailbox } from '@/server/purelymail-estate-functions';

const MAILBOX_KIND_OPTIONS = [
  { value: 'mailbox', label: 'Mailbox — receives and stores mail' },
  { value: 'alias', label: 'Alias — forwards to another address' },
  { value: 'catchall', label: 'Catch-all — forwards everything unmatched' }
];

const addMailboxFormSchema = z.object({
  domainId: z.string().min(1, 'A domain is required'),
  localPart: z
    .string()
    .trim()
    .min(1, 'Required')
    .refine((value) => !value.includes('@'), 'No "@" — just the part before it'),
  kind: z.enum(['mailbox', 'alias', 'catchall']),
  forwardTo: z.string().trim()
});

/**
 * A "real mailbox must not carry a forwarding address, an alias/catchall
 * must" biconditional — `assertKindShape` re-checks the SAME rule inside
 * `MailDomainsService.addMailbox`; this is only a legible error instead of a
 * server 500.
 */
function validateKindShape(values: z.infer<typeof addMailboxFormSchema>): string | undefined {
  const forwards = values.kind === 'alias' || values.kind === 'catchall';
  if (forwards && values.forwardTo.trim() === '') {
    return 'An alias or catch-all needs a forwarding address.';
  }
  if (!forwards && values.forwardTo.trim() !== '') {
    return 'A real mailbox must not have a forwarding address — pick "Alias" or "Catch-all" instead.';
  }
  return undefined;
}

/**
 * Section-level "New mailbox…" for the Purelymail estate page (loxep-4xo,
 * A9) — mounts `MailDomainsService.addMailbox` via {@link
 * addPurelymailMailbox}. A Loxep-own intent write (no Purelymail call
 * happens here — see that function's own doc), so there is no write-policy
 * tier to render blocked; this dialog is disabled only when the connection
 * has no domain Loxep declares yet, which is a real precondition, not a
 * policy flip.
 */
export default function AddMailboxDialog({
  connectionId,
  open,
  onOpenChange
}: {
  connectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: domainsResult } = useQuery(purelymailEstateDomainsQuery(connectionId));
  const domainOptions = (domainsResult?.status === 'ok' ? domainsResult.data : [])
    .filter((domain) => domain.loxep !== null)
    .map((domain) => ({
      value: domain.loxep?.managedDomainId ?? '',
      label: domain.name
    }));

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof addMailboxFormSchema>) =>
      addPurelymailMailbox({
        data: {
          connectionId,
          domainId: values.domainId,
          localPart: values.localPart,
          kind: values.kind,
          forwardTo: values.forwardTo.trim() === '' ? null : values.forwardTo.trim()
        }
      }),
    onSuccess: async (result) => {
      toast.success(
        `Mailbox intent for "${result.localPart}" added — the next mailbox sync provisions it at Purelymail.`
      );
      await queryClient.invalidateQueries({
        queryKey: purelymailEstateMailboxesQuery(connectionId).queryKey
      });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => toastError(error, 'Failed to add the mailbox')
  });

  const form = useAppForm({
    defaultValues: {
      domainId: '',
      localPart: '',
      kind: 'mailbox',
      forwardTo: ''
    } as z.infer<typeof addMailboxFormSchema>,
    validators: { onSubmit: addMailboxFormSchema },
    onSubmit: async ({ value }) => {
      const kindError = validateKindShape(value);
      if (kindError) {
        toast.error(kindError);
        return;
      }
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[440px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New mailbox</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Writes intent and enqueues a mailbox sync — the address is provisioned at Purelymail
            asynchronously, not from this dialog.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {domainOptions.length === 0 ? (
          <p className='text-muted-foreground text-sm'>
            No domain on this connection is declared in Loxep yet. Declare one under Infrastructure
            → Domains first.
          </p>
        ) : (
          <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
            <FieldGroup>
              <form.AppField
                name='domainId'
                children={(field) => (
                  <field.SelectField label='Domain' required options={domainOptions} />
                )}
              />
              <form.AppField
                name='localPart'
                children={(field) => (
                  <field.TextField
                    label='Local part'
                    required
                    placeholder='e.g. sales'
                    description='The part before the "@" — lower-cased automatically.'
                  />
                )}
              />
              <form.AppField
                name='kind'
                children={(field) => (
                  <field.SelectField label='Kind' required options={MAILBOX_KIND_OPTIONS} />
                )}
              />
              <form.AppField
                name='forwardTo'
                children={(field) => (
                  <field.TextField
                    label='Forwards to'
                    placeholder='Required for alias/catch-all only'
                  />
                )}
              />
            </FieldGroup>
            <div className='flex justify-end gap-2'>
              <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <form.AppForm>
                <form.SubmitButton>Add mailbox</form.SubmitButton>
              </form.AppForm>
            </div>
          </form>
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
