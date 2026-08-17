import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import RevealOnceDialog from '@/features/infrastructure/components/reveal-once-dialog';
import {
  dnsConnectionOptionsQuery,
  hostingTargetQuery,
  managedDomainsQuery
} from '@/features/infrastructure/api/queries';
import { mintDnsProviderToken } from '@/server/infrastructure-functions';

const mintFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  dnsConnectionId: z.string().min(1, 'A DNS connection is required'),
  domainIds: z.array(z.string())
});

/**
 * The mint action, and its reveal-once response — ADR-0022. `mintDnsProviderToken`
 * is a REQUEST-SCOPED admin server function, called directly from this
 * dialog's mutation, never enqueued: the plaintext value it returns is shown
 * here, in this response, exactly once.
 *
 * `dnsConnectionId` is a field on the FORM, not a fact derived from the
 * hosting target — a target carries no DNS-connection column of its own
 * (only `dns_provider_tokens`/`managed_domains` do), because minting can
 * scope a host to zones across more than one DNS account.
 */
export default function MintTokenDialog({
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
  const { data: dnsConnections } = useQuery(dnsConnectionOptionsQuery);
  const { data: domains } = useQuery(managedDomainsQuery);
  const [revealed, setRevealed] = React.useState<{ name: string; value: string } | null>(null);

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof mintFormSchema>) =>
      mintDnsProviderToken({
        data: {
          hostingTargetId,
          dnsConnectionId: values.dnsConnectionId,
          name: values.name.trim(),
          domainIds: values.domainIds
        }
      }),
    onSuccess: async (result) => {
      setRevealed({ name: result.token.name, value: result.value });
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
    },
    onError: (error) => toastError(error, 'Failed to mint token')
  });

  const form = useAppForm({
    defaultValues: { name: '', dnsConnectionId: '', domainIds: [] as string[] },
    validators: { onSubmit: mintFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  function close(next: boolean) {
    if (!next) {
      setRevealed(null);
      form.reset();
    }
    onOpenChange(next);
  }

  if (revealed !== null) {
    return (
      <RevealOnceDialog
        open={open}
        onOpenChange={close}
        title={`Token "${revealed.name}" minted`}
        description={`For ${hostingTargetName}. Paste this into the host's configuration now.`}
        value={revealed.value}
      />
    );
  }

  const domainOptions = (domains ?? []).map((domain) => ({ value: domain.id, label: domain.name }));
  const connectionOptions = (dnsConnections ?? []).map((connection) => ({
    value: connection.id,
    label: connection.name
  }));

  return (
    <ResponsiveDialog open={open} onOpenChange={close}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Mint a DNS token for {hostingTargetName}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A narrow, host-scoped credential the control plane mints — never one it authenticates
            with itself. The value is shown exactly once, in the response to this action.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. web-01 dns-edit' />
              )}
            />
            <form.AppField
              name='dnsConnectionId'
              children={(field) => (
                <field.SelectField
                  label='DNS connection'
                  required
                  options={connectionOptions}
                  placeholder='Select the DNS provider connection to mint against'
                />
              )}
            />
            <form.AppField
              name='domainIds'
              mode='array'
              children={(field) => (
                <field.CheckboxGroupField
                  label='Zone scope'
                  description='Which domains this token may edit. Leave empty and scope it afterward — scope changes are cheap and instant.'
                  options={domainOptions}
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => close(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Mint token</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
