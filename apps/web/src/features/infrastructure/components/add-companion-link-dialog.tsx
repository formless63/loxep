import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { hostingTargetQuery } from '@/features/infrastructure/api/queries';
import { addCompanionLink } from '@/server/infrastructure-functions';

const addLinkFormSchema = z.object({
  provider: z.string().trim().min(1, 'Provider is required').max(100),
  externalType: z.string().trim().min(1, 'Kind is required').max(100),
  url: z
    .string()
    .trim()
    .min(1, 'URL is required')
    .refine((value) => z.url().safeParse(value).success, {
      message: 'Enter a valid absolute URL'
    }),
  title: z.string().trim().max(200),
  purpose: z.string().trim().min(1, 'Purpose is required').max(100)
});

/**
 * The tier-1 "Add a companion link" form (loxep-v5r.3): a deep link to
 * whatever external tool the operator already runs — Beszel, Gatus,
 * Dockhand, a private wiki, anything with a URL. No credential, no adapter,
 * no vendor cooperation; see the fleet-observability and knowledge-tasks
 * designs' "tier 1" milestones this generic mechanism serves.
 *
 * Fields are deliberately generic (kind/label/url/provider, plus purpose —
 * required by `resource_links`' natural key but left free text here, since
 * this form has no domain-specific vocabulary of its own).
 */
export default function AddCompanionLinkDialog({
  open,
  onOpenChange,
  hostingTargetId,
  hostingTargetName
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hostingTargetId: string;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof addLinkFormSchema>) =>
      addCompanionLink({
        data: {
          hostingTargetId,
          provider: values.provider.trim(),
          externalType: values.externalType.trim(),
          url: values.url.trim(),
          title: values.title.trim() === '' ? null : values.title.trim(),
          purpose: values.purpose.trim()
        }
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
      close(false);
    },
    onError: (error) => toastError(error, 'Failed to add companion link')
  });

  const form = useAppForm({
    defaultValues: { provider: '', externalType: '', url: '', title: '', purpose: '' },
    validators: { onSubmit: addLinkFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  function close(next: boolean) {
    if (!next) form.reset();
    onOpenChange(next);
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={close}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add a companion link</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A deep link to a tool you already run — Beszel, Gatus, Dockhand, a private wiki,
            anything with a URL. Loxep links it; it never reimplements it.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='provider'
              children={(field) => (
                <field.TextField
                  label='Provider'
                  required
                  placeholder='e.g. beszel, gatus, dockhand'
                />
              )}
            />
            <form.AppField
              name='externalType'
              children={(field) => (
                <field.TextField
                  label='Kind'
                  required
                  placeholder='e.g. dashboard, hub, environment'
                  description='The kind of object at the other end of the URL.'
                />
              )}
            />
            <form.AppField
              name='url'
              children={(field) => <field.TextField label='URL' required placeholder='https://…' />}
            />
            <form.AppField
              name='title'
              children={(field) => (
                <field.TextField label='Label' placeholder='Optional display name' />
              )}
            />
            <form.AppField
              name='purpose'
              children={(field) => (
                <field.TextField
                  label='Purpose'
                  required
                  placeholder='e.g. metrics_console, uptime_check'
                  description='A short tag for what this link is for.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => close(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Add link</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
