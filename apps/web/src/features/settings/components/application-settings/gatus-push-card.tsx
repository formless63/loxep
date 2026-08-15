import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { updateGatusPushSettings, type GatusPushSettingsDto } from '@/server/admin-functions';
import { gatusPushSettingsQuery } from '@/features/settings/api/queries';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';

const gatusPushFormSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().refine((value) => value.trim() === '' || z.url().safeParse(value).success, {
    message: 'Base URL must be a valid URL'
  }),
  endpointKey: z
    .string()
    .refine(
      (value) => value.trim() === '' || /^[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/u.test(value.trim()),
      {
        message: 'Must look like <GROUP_NAME>_<ENDPOINT_NAME>'
      }
    ),
  mode: z.enum(['single', 'facts']),
  token: z.string()
});

type GatusPushFormValues = z.infer<typeof gatusPushFormSchema>;

/**
 * The Gatus outward health push (Phase 8 milestone 2, loxep-ovj.2): base URL
 * and `<GROUP>_<ENDPOINT>` key of the `external-endpoints` entry the
 * operator already declared in their own gatus YAML, plus a write-only
 * bearer token. Loxep never writes Gatus configuration — this form only
 * points Loxep at an endpoint that already exists.
 *
 * The base URL/key are ordinary registered-setting fields (read back and
 * echoed, like every other application setting); the token is write-only —
 * it is sent once, stored through the encrypted secrets service, and never
 * shown again, matching `NotificationEndpointDialog`'s token field exactly.
 */
export default function GatusPushCard({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery(gatusPushSettingsQuery);

  if (isPending) {
    return (
      <GatusPushShell>
        <p className='text-muted-foreground text-sm'>Loading…</p>
      </GatusPushShell>
    );
  }

  if (isError) {
    return (
      <GatusPushShell>
        <QueryErrorAlert
          error={error}
          title='Failed to load Gatus push settings'
          onRetry={() => refetch()}
        />
      </GatusPushShell>
    );
  }

  return (
    <GatusPushShell enabled={data.enabled}>
      {isAdmin ? (
        <GatusPushForm
          data={data}
          onSaved={() =>
            queryClient.invalidateQueries({ queryKey: gatusPushSettingsQuery.queryKey })
          }
        />
      ) : (
        <dl className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
          <dt className='text-muted-foreground'>Base URL</dt>
          <dd>{data.baseUrl ?? '—'}</dd>
          <dt className='text-muted-foreground'>Endpoint key</dt>
          <dd>{data.endpointKey ?? '—'}</dd>
          <dt className='text-muted-foreground'>Mode</dt>
          <dd>{data.mode === 'facts' ? 'Five facts' : 'Single (overall status)'}</dd>
          <dt className='text-muted-foreground'>Push token</dt>
          <dd>{data.hasToken ? 'Configured' : 'Not set'}</dd>
        </dl>
      )}
    </GatusPushShell>
  );
}

function GatusPushShell({ enabled, children }: { enabled?: boolean; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-base'>
          Gatus outward health push
          {enabled !== undefined && (
            <Badge variant={enabled ? 'default' : 'secondary'}>
              {enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Publishes Loxep&apos;s own overall health to an{' '}
          <code className='font-mono'>external-endpoints</code> entry declared in the
          operator&apos;s own Gatus instance every five minutes. Loxep never writes Gatus
          configuration — declare the endpoint and its heartbeat interval in gatus first, then point
          Loxep at it here.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function GatusPushForm({ data, onSaved }: { data: GatusPushSettingsDto; onSaved: () => void }) {
  const mutation = useMutation({
    mutationFn: (values: GatusPushFormValues) =>
      updateGatusPushSettings({
        data: {
          enabled: values.enabled,
          baseUrl: values.baseUrl.trim() === '' ? null : values.baseUrl.trim(),
          endpointKey: values.endpointKey.trim() === '' ? null : values.endpointKey.trim(),
          mode: values.mode,
          token: values.token.trim() === '' ? undefined : values.token.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Gatus push settings saved');
      onSaved();
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to save Gatus push settings')
  });

  const form = useAppForm({
    defaultValues: {
      enabled: data.enabled,
      baseUrl: data.baseUrl ?? '',
      endpointKey: data.endpointKey ?? '',
      mode: data.mode,
      token: ''
    },
    validators: {
      onSubmit: gatusPushFormSchema
    },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
        form.setFieldValue('token', '');
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <FieldGroup>
        <form.AppField
          name='enabled'
          children={(field) => (
            <field.SwitchField
              label='Enabled'
              description='While disabled the push task no-ops every cycle.'
            />
          )}
        />
        <form.AppField
          name='baseUrl'
          children={(field) => (
            <field.TextField
              label='Gatus base URL'
              placeholder='https://gatus.example.com'
              description='The operator-run Gatus instance to push to.'
            />
          )}
        />
        <form.AppField
          name='endpointKey'
          children={(field) => (
            <field.TextField
              label='Endpoint key'
              placeholder='core_loxep'
              description="<GROUP_NAME>_<ENDPOINT_NAME>, exactly as declared under external-endpoints in the operator's gatus YAML. In 'Five facts' mode this is the derivation seed for five keys, never pushed to directly."
            />
          )}
        />
        <form.AppField
          name='mode'
          children={(field) => (
            <field.SelectField
              label='What gets published'
              options={[
                { value: 'single', label: 'Single (overall status) — today’s behavior' },
                {
                  value: 'facts',
                  label:
                    'Five facts (worker backlog, sync freshness, notifications, drift, readiness)'
                }
              ]}
              description="'Five facts' needs five matching external-endpoints entries declared in the operator's gatus YAML, one per fact, before it does anything more than 'Single' did — see the Gatus push guide."
            />
          )}
        />
        <form.AppField
          name='token'
          children={(field) => (
            <field.TextField
              label='Push token'
              type='password'
              autoComplete='new-password'
              placeholder={data.hasToken ? '•••••••• (unchanged)' : 'Optional'}
              description="Write-only: stored encrypted, never displayed again. Must match the bearer token the operator's gatus YAML declares for this endpoint."
            />
          )}
        />
      </FieldGroup>
      <div className='flex justify-end'>
        <form.AppForm>
          <form.SubmitButton>Save</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}
