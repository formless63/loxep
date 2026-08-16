import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  dnsConnectionOptionsQuery,
  hostingTargetOptionsQuery,
  mailConnectionOptionsQuery
} from '@/features/infrastructure/api/queries';
import TemplateStepsList from '@/features/infrastructure/components/template-steps-list';
import {
  previewProvisioningTemplateRun,
  startProvisioningTemplateRun
} from '@/server/provisioning-functions';
import type {
  CompiledPlanDto,
  ProvisioningTemplateDetailDto
} from '@/server/provisioning-functions';

/**
 * A dynamic-input wizard: one field per `${placeholder}` the template's own
 * steps reference (`ProvisioningTemplateDetailDto.inputKeys`), rather than a
 * hand-authored form per template. A handful of WELL-KNOWN key names get a
 * connection/hosting-target picker (the same option lists `NewDomainForm`
 * already uses); every other key gets a plain text field — honest rather
 * than guessed, and still validated for real by `compileTemplate` itself.
 */
function fieldKindFor(
  key: string
): 'dns-connection' | 'mail-connection' | 'hosting-target' | 'text' {
  if (key === 'dnsConnectionId') return 'dns-connection';
  if (key === 'mailConnectionId') return 'mail-connection';
  if (key === 'hostingTargetId') return 'hosting-target';
  return 'text';
}

export default function TemplateRunWizardForm({
  template
}: {
  template: ProvisioningTemplateDetailDto;
}) {
  const navigate = useNavigate();
  const { data: dnsConnections } = useQuery(dnsConnectionOptionsQuery);
  const { data: mailConnections } = useQuery(mailConnectionOptionsQuery);
  const { data: hostingTargets } = useQuery(hostingTargetOptionsQuery);

  const [preview, setPreview] = React.useState<CompiledPlanDto | null>(null);
  const [previewedInputs, setPreviewedInputs] = React.useState<string | null>(null);

  const previewMutation = useMutation({
    mutationFn: (inputs: Record<string, string>) =>
      previewProvisioningTemplateRun({ data: { templateId: template.id, inputs } }),
    onSuccess: (plan, inputs) => {
      setPreview(plan);
      setPreviewedInputs(JSON.stringify(inputs));
    },
    onError: (error) => {
      setPreview(null);
      setPreviewedInputs(null);
      toastError(error, 'Could not compile this plan — check the inputs above');
    }
  });

  const startMutation = useMutation({
    mutationFn: (inputs: Record<string, string>) =>
      startProvisioningTemplateRun({ data: { templateId: template.id, inputs } }),
    onSuccess: async (result) => {
      toast.success('Run started — the driver will advance it as far as it currently can');
      await navigate({ to: '/infrastructure/templates/runs/$id', params: { id: result.id } });
    },
    onError: (error) => toastError(error, 'Could not start this run')
  });

  const defaultValues = Object.fromEntries(template.inputKeys.map((key) => [key, ''])) as Record<
    string,
    string
  >;

  const form = useAppForm({
    defaultValues,
    onSubmit: async ({ value }) => {
      await startMutation.mutateAsync(value);
    }
  });

  const currentValuesKey = JSON.stringify(form.state.values);
  const previewIsStale = previewedInputs !== currentValuesKey;

  if (template.inputKeys.length === 0) {
    return (
      <Alert>
        <Icons.info />
        <AlertTitle>This template has no inputs</AlertTitle>
        <AlertDescription>
          Every step's parameters are literal — nothing to fill in. Preview the plan and start.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className='flex max-w-3xl flex-col gap-6'>
      <form
        className='space-y-6'
        onSubmit={submitFormEvent(() => {
          // Compiling the preview is MANDATORY before a run may start — see
          // the design's own "explicit apply from a shown plan" rule.
          previewMutation.mutate(form.state.values as Record<string, string>);
        })}
      >
        <FieldGroup>
          {template.inputKeys.map((key) => {
            const kind = fieldKindFor(key);
            if (kind === 'dns-connection') {
              return (
                <form.AppField
                  key={key}
                  name={key}
                  children={(field) => (
                    <field.SelectField
                      label='DNS connection'
                      required
                      options={(dnsConnections ?? []).map((c) => ({ value: c.id, label: c.name }))}
                      placeholder='Select a DNS provider connection'
                    />
                  )}
                />
              );
            }
            if (kind === 'mail-connection') {
              return (
                <form.AppField
                  key={key}
                  name={key}
                  children={(field) => (
                    <field.SelectField
                      label='Mail connection'
                      required
                      options={(mailConnections ?? []).map((c) => ({ value: c.id, label: c.name }))}
                      placeholder='Select a mail provider connection'
                    />
                  )}
                />
              );
            }
            if (kind === 'hosting-target') {
              return (
                <form.AppField
                  key={key}
                  name={key}
                  children={(field) => (
                    <field.SelectField
                      label='Hosting target'
                      required
                      options={(hostingTargets ?? []).map((t) => ({ value: t.id, label: t.name }))}
                      placeholder='Select the origin hosting target'
                    />
                  )}
                />
              );
            }
            return (
              <form.AppField
                key={key}
                name={key}
                children={(field) => <field.TextField label={key} required />}
              />
            );
          })}
        </FieldGroup>
        <Button type='submit' variant='outline' disabled={previewMutation.isPending}>
          <Icons.code />
          Preview compiled plan
        </Button>
      </form>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Compiled plan preview</CardTitle>
            <CardDescription>
              {previewIsStale
                ? 'Inputs changed since this preview — preview again before starting.'
                : `This run will execute ${preview.steps.length} step${preview.steps.length === 1 ? '' : 's'} in order. Nothing has been created yet.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TemplateStepsList
              steps={preview.steps.map((step, index) => ({
                id: `preview-${index}`,
                sequence: step.sequence,
                stepKind: step.stepKind,
                provider: step.provider,
                params: step.params,
                optional: step.optional
              }))}
            />
          </CardContent>
        </Card>
      )}

      <div>
        <Button
          disabled={preview === null || previewIsStale || startMutation.isPending}
          onClick={() => startMutation.mutate(form.state.values as Record<string, string>)}
        >
          <Icons.arrowRight />
          Start run
        </Button>
        {preview === null && (
          <p className='text-muted-foreground mt-2 text-xs'>
            Preview the compiled plan first — the design's own rule: see what this will create
            before it does.
          </p>
        )}
      </div>
    </div>
  );
}
