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
  hostingTargetOptionsQuery,
  managedDomainOptionsQuery,
  pangolinEstateOverviewQuery
} from '@/features/infrastructure/api/queries';
import { adoptPangolinResourceAsProxyResource } from '@/server/pangolin-estate-functions';
import type { PangolinEstateResourceDto } from '@/server/pangolin-estate-functions';

const adoptFormSchema = z.object({
  domainId: z.string().trim().min(1, 'Choose the domain this resource belongs to'),
  hostingTargetId: z.string().trim().min(1, 'Choose which hosting target this resource fronts')
});

/**
 * "Adopt as declared resource" (loxep-pq2): turns one LIVE Pangolin resource
 * into a declared `proxy_resources` intent row. Pangolin's own domain/target
 * have no direct foreign key into Loxep's schema — a resource's `domainId`
 * names a Pangolin org-domain, not a `managed_domains` row, and its targets
 * name IPs/ports, not a `hosting_targets` row — so the operator confirms
 * both here, the same "best-effort guess, cheap to redo, never silently
 * corrupted" tradeoff `adoptContainerHostAsHostingTarget`'s own doc accepts.
 * The domain picker defaults to whichever managed domain's name matches this
 * resource's `fullDomain` suffix, when exactly one does.
 */
export default function AdoptPangolinResourceDialog({
  open,
  onOpenChange,
  connectionId,
  resource
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connectionId: string;
  resource: PangolinEstateResourceDto;
}) {
  const queryClient = useQueryClient();
  const { data: domains } = useQuery(managedDomainOptionsQuery);
  const { data: hostingTargets } = useQuery(hostingTargetOptionsQuery);

  const defaultDomainId =
    resource.fullDomain === null
      ? ''
      : ((domains ?? []).find(
          (domain) =>
            domain.name === resource.fullDomain || resource.fullDomain?.endsWith(`.${domain.name}`)
        )?.id ?? '');

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof adoptFormSchema>) =>
      adoptPangolinResourceAsProxyResource({
        data: {
          connectionId,
          externalResourceId: resource.resourceId === null ? '' : String(resource.resourceId),
          subdomain: resource.subdomain,
          mode: resource.mode ?? 'http',
          ssl: resource.ssl,
          externalDomainId: resource.domainId,
          domainId: values.domainId,
          hostingTargetId: values.hostingTargetId
        }
      }),
    onSuccess: async (result) => {
      toast.success(
        result.created
          ? 'Adopted — Loxep now declares this resource; apply from the domain or fleet detail page when ready'
          : 'This resource was already declared — nothing changed'
      );
      await queryClient.invalidateQueries({
        queryKey: pangolinEstateOverviewQuery(connectionId).queryKey
      });
      close(false);
    },
    onError: (error) => toastError(error, 'Failed to adopt this resource')
  });

  const form = useAppForm({
    defaultValues: { domainId: defaultDomainId, hostingTargetId: '' },
    validators: { onSubmit: adoptFormSchema },
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

  if (resource.resourceId === null) return null;

  return (
    <ResponsiveDialog open={open} onOpenChange={close}>
      <ResponsiveDialogContent className='sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            Adopt &quot;{resource.fullDomain ?? resource.name ?? 'this resource'}&quot;
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Declares this Pangolin resource in Loxep — a `proxy_resources` row Loxep will manage
            from here on. This writes only Loxep&apos;s own record; nothing is sent to Pangolin.
            Apply, retire, and re-enable become available afterward from the domain or fleet detail
            page.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='domainId'
              children={(field) => (
                <field.SelectField
                  label='Managed domain'
                  required
                  placeholder='Choose a domain'
                  options={(domains ?? []).map((domain) => ({
                    value: domain.id,
                    label: domain.name
                  }))}
                />
              )}
            />
            <form.AppField
              name='hostingTargetId'
              children={(field) => (
                <field.SelectField
                  label='Hosting target'
                  required
                  placeholder='Choose a hosting target'
                  options={(hostingTargets ?? []).map((target) => ({
                    value: target.id,
                    label: target.name
                  }))}
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => close(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Adopt</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
