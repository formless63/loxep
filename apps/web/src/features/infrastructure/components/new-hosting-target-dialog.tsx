import * as React from 'react';
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
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { FieldGroup } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { CONTROL_SURFACE_OPTIONS } from '@/features/infrastructure/constants';
import {
  dockhandConnectionOptionsQuery,
  hostingTargetOptionsQuery,
  hostingTargetsQuery
} from '@/features/infrastructure/api/queries';
import { createHostingTarget, declareContainerHostIntent } from '@/server/infrastructure-functions';
import DockhandRegistrationFields, {
  type DockhandRegistrationValue,
  emptyDockhandRegistrationValue,
  dockhandRegistrationToIntentInput
} from '@/features/infrastructure/components/dockhand-registration-fields';

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
  // `hosting_targets_addressable_check`: a target that is not deliberately
  // address-less must be resolvable to something — its own address, or a
  // fronting node's.
  if (
    values.controlSurface !== 'none' &&
    !hasFrontingNode &&
    values.addressV4.trim() === '' &&
    values.addressV6.trim() === ''
  ) {
    return 'An addressable target needs an IPv4 or IPv6 address (or pick "DNS only").';
  }
  return undefined;
}

export default function NewHostingTargetDialog({
  open,
  onOpenChange,
  initialName,
  onCreated
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Prefills the `name` field only (loxep-50t §4 item 2 — "declare as
   * hosting target"). Never prefill `addressV4`/`addressV6` from a
   * discovered candidate: those feed the DNS materializer, and a tailnet
   * (CGNAT) address published as an A/AAAA record is an outage that
   * presents as a propagation problem (§3.2). This dialog's address fields
   * stay operator-typed-only regardless of what opened it.
   */
  initialName?: string;
  /**
   * Called after a successful create, before the dialog closes — the
   * fleet candidates panel's "declare" action uses this to attach the
   * originating device in the same operator-facing action (not the same
   * database transaction: `hostingTargets.create` and
   * `resourceLinks.attachLink` each own their own, and composing a shared
   * one is out of this change's scope). If this rejects, the target still
   * exists and the device remains linkable via the panel's "Link" action —
   * a recoverable failure, not a duplicate or a lost write, because
   * `attachLink` is idempotent.
   */
  onCreated?: (target: { id: string; name: string }) => void | Promise<void>;
}) {
  const queryClient = useQueryClient();
  const { data: targets } = useQuery(hostingTargetOptionsQuery);
  const { data: dockhandConnections } = useQuery(dockhandConnectionOptionsQuery);

  // loxep-hb7 Milestone C: the create dialog's "also register this host in
  // Dockhand" section. Collapsed and OFF by default, and rendered only when
  // at least one Dockhand connection exists — never a disabled control (hb7
  // §2.1(a)). Plain state, not a form field: this is a genuinely separate
  // write (`declareContainerHostIntent`, its own transaction) fired from
  // `onSuccess` below, never part of `createHostingTarget`'s own payload.
  const [registerInDockhand, setRegisterInDockhand] = React.useState(false);
  const [dockhandValue, setDockhandValue] = React.useState<DockhandRegistrationValue>(
    emptyDockhandRegistrationValue
  );

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
    onSuccess: async (result) => {
      toast.success('Hosting target created');
      if (registerInDockhand && dockhandValue.connectionId !== '') {
        try {
          await declareContainerHostIntent({
            data: dockhandRegistrationToIntentInput(result.id, dockhandValue)
          });
          toast.success('Dockhand registration queued');
        } catch (error) {
          // The target still exists — the fleet-detail registration panel
          // is the recoverable retry path (hb7 §2.1(b)), so this is reported
          // rather than rolled back.
          toastError(error, 'Hosting target created, but Dockhand registration failed');
        }
      }
      await queryClient.invalidateQueries({ queryKey: hostingTargetsQuery.queryKey });
      await onCreated?.(result);
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to create hosting target')
  });

  const form = useAppForm({
    defaultValues: {
      name: initialName ?? '',
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

          {(dockhandConnections ?? []).length > 0 && (
            <Collapsible open={registerInDockhand} onOpenChange={setRegisterInDockhand}>
              <div className='flex items-center justify-between gap-2 rounded-md border px-3 py-2'>
                <div>
                  <p className='text-sm font-medium'>Also register this host in Dockhand</p>
                  <p className='text-muted-foreground text-sm'>
                    Writes the desired host record; a worker applies it after creation.
                  </p>
                </div>
                <Switch
                  checked={registerInDockhand}
                  onCheckedChange={(next) => {
                    setRegisterInDockhand(next);
                    if (
                      next &&
                      dockhandValue.connectionId === '' &&
                      dockhandConnections?.length === 1
                    ) {
                      setDockhandValue((current) => ({
                        ...current,
                        connectionId: dockhandConnections[0]?.id ?? ''
                      }));
                    }
                  }}
                />
              </div>
              <CollapsibleContent className='pt-3'>
                <DockhandRegistrationFields value={dockhandValue} onChange={setDockhandValue} />
              </CollapsibleContent>
            </Collapsible>
          )}

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
