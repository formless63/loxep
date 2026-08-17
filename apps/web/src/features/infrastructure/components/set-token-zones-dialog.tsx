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
import { hostingTargetQuery, managedDomainsQuery } from '@/features/infrastructure/api/queries';
import { setDnsProviderTokenZones } from '@/server/infrastructure-functions';
import type { DnsProviderTokenDto } from '@/server/infrastructure-functions';

const zonesFormSchema = z.object({ domainIds: z.array(z.string()) });

/**
 * Scope editing — deliberately its own small dialog, never a neighbour of
 * roll. No redeployment, no value change: cheap and instant, styled as an
 * ordinary edit rather than a destructive action.
 */
export default function SetTokenZonesDialog({
  open,
  onOpenChange,
  token,
  hostingTargetName
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: DnsProviderTokenDto;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();
  const { data: domains } = useQuery(managedDomainsQuery);

  const mutation = useMutation({
    mutationFn: (domainIds: string[]) =>
      setDnsProviderTokenZones({ data: { tokenId: token.id, domainIds } }),
    onSuccess: async () => {
      toast.success('Zone scope updated — the policy sync is enqueued');
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to update zone scope')
  });

  const form = useAppForm({
    defaultValues: { domainIds: token.domainIds },
    validators: { onSubmit: zonesFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value.domainIds);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const domainOptions = (domains ?? []).map((domain) => ({ value: domain.id, label: domain.name }));

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Edit zone scope for "{token.name}"</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A policy update replaces the whole set — the sync task rebuilds it from this selection
            every time. This does not change the token's value.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='domainIds'
              mode='array'
              children={(field) => (
                <field.CheckboxGroupField label='Zones' options={domainOptions} />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save scope</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
