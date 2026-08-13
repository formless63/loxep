import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  dnsConnectionOptionsQuery,
  hostingTargetOptionsQuery,
  managedDomainsQuery
} from '@/features/infrastructure/api/queries';
import { createManagedDomain } from '@/server/infrastructure-functions';

const NO_TARGET_VALUE = '__dns_only__';

const domainFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .refine((value) => value.includes('.'), 'Must be a domain name, e.g. example.com'),
  dnsConnectionId: z.string().min(1, 'A DNS connection is required'),
  apexTargetId: z.string(),
  apexProxied: z.boolean(),
  wildcardProxied: z.boolean(),
  mailEnabled: z.boolean(),
  registrar: z.string()
});

/**
 * The wizard. Writes INTENT and enqueues `infrastructure.materialize-records`
 * (inside `createManagedDomain`'s single transaction), then redirects — it
 * never awaits a provider call. State advances asynchronously; the operator
 * lands on the domain detail page and watches it move.
 */
export default function NewDomainForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: dnsConnections } = useQuery(dnsConnectionOptionsQuery);
  const { data: hostingTargets } = useQuery(hostingTargetOptionsQuery);

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof domainFormSchema>) =>
      createManagedDomain({
        data: {
          name: values.name.trim(),
          dnsConnectionId: values.dnsConnectionId,
          apexTargetId: values.apexTargetId === NO_TARGET_VALUE ? null : values.apexTargetId,
          apexProxied: values.apexProxied,
          wildcardProxied: values.wildcardProxied,
          mailEnabled: values.mailEnabled,
          registrar: values.registrar.trim() === '' ? undefined : values.registrar.trim()
        }
      }),
    onSuccess: async (result) => {
      toast.success(`"${result.name}" declared — the reconciler is provisioning it`);
      await queryClient.invalidateQueries({ queryKey: managedDomainsQuery.queryKey });
      await navigate({ to: '/infrastructure/domains/$name', params: { name: result.name } });
    },
    onError: (error) => toastError(error, 'Failed to declare domain')
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      dnsConnectionId: '',
      apexTargetId: NO_TARGET_VALUE,
      apexProxied: true,
      wildcardProxied: true,
      mailEnabled: true,
      registrar: ''
    },
    validators: { onSubmit: domainFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  if (dnsConnections !== undefined && dnsConnections.length === 0) {
    return (
      <Alert>
        <Icons.info />
        <AlertTitle>No DNS connection yet</AlertTitle>
        <AlertDescription>
          Declaring a domain needs a DNS provider connection first. Add one under Settings →
          Integrations → Infrastructure, then come back here.
        </AlertDescription>
      </Alert>
    );
  }

  const targetOptions = [
    { value: NO_TARGET_VALUE, label: 'DNS only — no hosting target' },
    ...(hostingTargets ?? []).map((target) => ({ value: target.id, label: target.name }))
  ];
  const connectionOptions = (dnsConnections ?? []).map((connection) => ({
    value: connection.id,
    label: connection.name
  }));

  return (
    <form className='max-w-xl space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <FieldGroup>
        <form.AppField
          name='name'
          children={(field) => (
            <field.TextField label='Domain name' required placeholder='example.com' />
          )}
        />
        <form.AppField
          name='dnsConnectionId'
          children={(field) => (
            <field.SelectField
              label='DNS connection'
              required
              options={connectionOptions}
              placeholder='Select a DNS provider connection'
            />
          )}
        />
        <form.AppField
          name='apexTargetId'
          children={(field) => (
            <field.SelectField
              label='Hosting target'
              options={targetOptions}
              description='What the apex and wildcard records should point at. Change any time.'
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
              description='Register this domain with a mail provider once its zone is active.'
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
      </FieldGroup>
      <form.AppForm>
        <form.SubmitButton>Declare domain</form.SubmitButton>
      </form.AppForm>
    </form>
  );
}
