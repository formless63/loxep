import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
import {
  hostingTargetOptionsQuery,
  managedDomainQuery,
  managedDomainsQuery
} from '@/features/infrastructure/api/queries';
import { updateManagedDomainIntent } from '@/server/infrastructure-functions';
import type { ManagedDomainDetailDto } from '@/server/infrastructure-functions';

const NO_TARGET_VALUE = '__dns_only__';

const editDomainFormSchema = z.object({
  apexTargetId: z.string(),
  apexProxied: z.boolean(),
  wildcardProxied: z.boolean(),
  mailEnabled: z.boolean(),
  registrar: z.string(),
  notes: z.string()
});

/**
 * Edit affordance for `updateManagedDomainIntent`
 * (`apps/web/src/server/infrastructure-functions.ts:1121` at the time this
 * was written) — orphaned before this bead (A10): apex retarget, proxy
 * flags, registrar, and notes all required SQL. Mounts the SAME server
 * function `new-domain-form.tsx`'s wizard never called.
 *
 * A FOCUSED DIALOG over exactly the fields `updateManagedDomainIntent`
 * accepts, not `new-domain-form.tsx` reused in an "edit mode": that wizard's
 * `name`/`dnsConnectionId` fields are create-only (the domain's identity and
 * its DNS provider are fixed at declare-time — `updateManagedDomainIntent`'s
 * own input schema has no `name`/`dnsConnectionId` field to send), and it has
 * no `notes` field at all despite `createManagedDomainInput` accepting one.
 * Branching that one component between "declare" and "edit" shapes would
 * mean conditionally hiding two required fields and bolting on a field the
 * create flow never had — more surface area than a second, smaller
 * component with the exact edit-only field set.
 *
 * Gating matches the surrounding domain mutations (admin-only, enforced
 * server-side by `requireAdmin` inside `updateManagedDomainIntent` itself);
 * `apexTargetId`/`apexProxied`/`wildcardProxied`/`mailEnabled` are Loxep-own
 * intent (no provider write policy applies, matching `enableMailForDomain`'s
 * own precedent) — the reconciler applies the new intent on its own next
 * pass, the same asynchronous shape `createManagedDomain` already documents.
 */
export default function EditDomainDialog({
  domain,
  open,
  onOpenChange
}: {
  domain: ManagedDomainDetailDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: hostingTargets } = useQuery(hostingTargetOptionsQuery);

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof editDomainFormSchema>) =>
      updateManagedDomainIntent({
        data: {
          id: domain.id,
          apexTargetId: values.apexTargetId === NO_TARGET_VALUE ? null : values.apexTargetId,
          apexProxied: values.apexProxied,
          wildcardProxied: values.wildcardProxied,
          mailEnabled: values.mailEnabled,
          registrar: values.registrar.trim() === '' ? null : values.registrar.trim(),
          notes: values.notes.trim() === '' ? null : values.notes.trim()
        }
      }),
    onSuccess: async () => {
      toast.success('Domain intent updated — the reconciler converges it on its next pass.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: managedDomainQuery(domain.name).queryKey }),
        queryClient.invalidateQueries({ queryKey: managedDomainsQuery.queryKey })
      ]);
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to update this domain')
  });

  const form = useAppForm({
    defaultValues: {
      apexTargetId: domain.apexTargetId ?? NO_TARGET_VALUE,
      apexProxied: domain.apexProxied,
      wildcardProxied: domain.wildcardProxied,
      mailEnabled: domain.mailEnabled,
      registrar: domain.registrar ?? '',
      notes: domain.notes ?? ''
    } as z.infer<typeof editDomainFormSchema>,
    validators: { onSubmit: editDomainFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const targetOptions = [
    { value: NO_TARGET_VALUE, label: 'DNS only — no hosting target' },
    ...(hostingTargets ?? []).map((target) => ({ value: target.id, label: target.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit "{domain.name}"</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Writes intent only — the reconciler applies it asynchronously, same as declaring a
            domain.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='apexTargetId'
              children={(field) => (
                <field.SelectField
                  label='Hosting target'
                  options={targetOptions}
                  description='What the apex and wildcard records should point at.'
                />
              )}
            />
            <form.AppField
              name='apexProxied'
              children={(field) => (
                <field.SwitchField
                  label='Proxy the apex record'
                  description="Route the apex through the DNS provider's edge rather than answering with the origin address directly."
                />
              )}
            />
            <form.AppField
              name='wildcardProxied'
              children={(field) => (
                <field.SwitchField
                  label='Proxy the wildcard record'
                  description='Same, for *.domain.'
                />
              )}
            />
            <form.AppField
              name='mailEnabled'
              children={(field) => (
                <field.SwitchField
                  label='Mail enabled'
                  description='Turning this off does not remove an existing mail registration — it only stops new registration/verification.'
                />
              )}
            />
            <form.AppField
              name='registrar'
              children={(field) => (
                <field.TextField
                  label='Registrar'
                  placeholder='Optional — a note, not an integration'
                  description='Denormalized text. Loxep verifies delegation through the DNS provider, not a registrar API.'
                />
              )}
            />
            <form.AppField
              name='notes'
              children={(field) => <field.TextareaField label='Notes' placeholder='Optional' />}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save changes</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
