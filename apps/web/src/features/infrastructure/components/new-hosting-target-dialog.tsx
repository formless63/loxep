import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { CONTROL_SURFACE_OPTIONS } from '@/features/infrastructure/constants';
import {
  hostingTargetOptionsQuery,
  hostingTargetsQuery
} from '@/features/infrastructure/api/queries';
import { createHostingTarget } from '@/server/infrastructure-functions';

const NO_FRONTING_NODE = '__none__';

const targetFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  controlSurface: z.enum(['proxy_node', 'tunnel_client', 'direct_reverse_proxy', 'none']),
  provider: z.string(),
  region: z.string(),
  addressV4: z.string(),
  addressV6: z.string(),
  frontedByTargetId: z.string()
});

/**
 * `control_surface = 'tunnel_client'` REQUIRES a fronting node — the same
 * biconditional `hosting_targets_tunnel_client_check` enforces at the
 * database. Checked here so the error is legible instead of a constraint
 * name.
 */
function validateFrontingShape(values: z.infer<typeof targetFormSchema>): string | undefined {
  const hasFrontingNode = values.frontedByTargetId !== NO_FRONTING_NODE;
  if (values.controlSurface === 'tunnel_client' && !hasFrontingNode) {
    return 'A tunnel client needs a fronting node.';
  }
  if (values.controlSurface !== 'tunnel_client' && hasFrontingNode) {
    return 'Only a tunnel client may have a fronting node.';
  }
  return undefined;
}

export default function NewHostingTargetDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: targets } = useQuery(hostingTargetOptionsQuery);

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof targetFormSchema>) =>
      createHostingTarget({
        data: {
          name: values.name.trim(),
          controlSurface: values.controlSurface,
          provider: values.provider.trim() === '' ? undefined : values.provider.trim(),
          region: values.region.trim() === '' ? undefined : values.region.trim(),
          addressV4: values.addressV4.trim() === '' ? undefined : values.addressV4.trim(),
          addressV6: values.addressV6.trim() === '' ? undefined : values.addressV6.trim(),
          frontedByTargetId:
            values.frontedByTargetId === NO_FRONTING_NODE ? undefined : values.frontedByTargetId
        }
      }),
    onSuccess: async () => {
      toast.success('Hosting target created');
      await queryClient.invalidateQueries({ queryKey: hostingTargetsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to create hosting target')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      controlSurface: 'direct_reverse_proxy',
      provider: '',
      region: '',
      addressV4: '',
      addressV6: '',
      frontedByTargetId: NO_FRONTING_NODE
    } as z.infer<typeof targetFormSchema>,
    validators: { onSubmit: targetFormSchema },
    onSubmit: async ({ value }) => {
      // Cross-field check the schema alone cannot express — the same
      // biconditional `hosting_targets_tunnel_client_check` enforces at the
      // database, surfaced here as a legible error rather than a constraint
      // name.
      const frontingError = validateFrontingShape(value);
      if (frontingError) {
        toast.error(frontingError);
        return;
      }
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const frontingOptions = [
    { value: NO_FRONTING_NODE, label: 'None' },
    ...(targets ?? []).map((target) => ({ value: target.id, label: target.name }))
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>New hosting target</DialogTitle>
          <DialogDescription>
            A place a name can point at: a node, a tunnel-connected host, a bare server, or
            explicitly nothing.
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. web-01' />
              )}
            />
            <form.AppField
              name='controlSurface'
              children={(field) => (
                <field.SelectField
                  label='Control surface'
                  required
                  options={CONTROL_SURFACE_OPTIONS}
                />
              )}
            />
            <form.AppField
              name='provider'
              children={(field) => (
                <field.TextField label='Provider' placeholder='Optional — a note, e.g. hetzner' />
              )}
            />
            <form.AppField
              name='region'
              children={(field) => <field.TextField label='Region' placeholder='Optional' />}
            />
            <form.AppField
              name='addressV4'
              children={(field) => <field.TextField label='IPv4 address' placeholder='Optional' />}
            />
            <form.AppField
              name='addressV6'
              children={(field) => <field.TextField label='IPv6 address' placeholder='Optional' />}
            />
            <form.AppField
              name='frontedByTargetId'
              children={(field) => (
                <field.SelectField
                  label='Fronted by'
                  options={frontingOptions}
                  description='Only for a tunnel client — the node whose address the materializer publishes instead of this one.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Create</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
