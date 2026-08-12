import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import type { MarketEventType } from '@loxep/market';
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
import {
  createNotificationRule,
  updateNotificationRule,
  type MonitorTargetOptionDto,
  type NotificationEndpointDto,
  type NotificationRuleDto
} from '@/server/admin-functions';
import { notificationRulesQuery } from '@/features/settings/api/queries';
import {
  ANY_MARKET_EVENT_TYPE_VALUE,
  ANY_MONITOR_TARGET_VALUE,
  marketEventTypeOptions
} from '@/features/settings/constants';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';

const ruleFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  endpointId: z.string().min(1, 'Endpoint is required'),
  marketEventType: z.string(),
  monitorTargetId: z.string(),
  enabled: z.boolean()
});

type RuleFormValues = z.infer<typeof ruleFormSchema>;

/**
 * Create/edit dialog for notification rules: which market events (any, or
 * one `market_event_type`) for which monitor target (any, or one) route to
 * which endpoint. `matchRules` (`@loxep/notifications`) treats a NULL filter
 * as "any" — the sentinel values here map back to NULL on submit.
 */
export default function NotificationRuleDialog({
  open,
  onOpenChange,
  rule,
  endpoints,
  monitorTargets
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: NotificationRuleDto | null;
  endpoints: NotificationEndpointDto[];
  monitorTargets: MonitorTargetOptionDto[];
}) {
  const queryClient = useQueryClient();
  const isEdit = rule !== null;

  const endpointOptions = endpoints.map((endpoint) => ({
    value: endpoint.id,
    label: endpoint.name
  }));
  const eventTypeOptions = [
    { value: ANY_MARKET_EVENT_TYPE_VALUE, label: 'Any event type' },
    ...marketEventTypeOptions
  ];
  const monitorTargetOptions = [
    { value: ANY_MONITOR_TARGET_VALUE, label: 'Any monitor target' },
    ...monitorTargets.map((target) => ({ value: target.id, label: target.name }))
  ];

  const mutation = useMutation({
    mutationFn: (values: RuleFormValues) => {
      const marketEventType: MarketEventType | null =
        values.marketEventType === ANY_MARKET_EVENT_TYPE_VALUE
          ? null
          : (values.marketEventType as MarketEventType);
      const monitorTargetId =
        values.monitorTargetId === ANY_MONITOR_TARGET_VALUE ? null : values.monitorTargetId;
      if (isEdit) {
        return updateNotificationRule({
          data: {
            id: rule.id,
            name: values.name,
            enabled: values.enabled,
            marketEventType,
            monitorTargetId
          }
        });
      }
      return createNotificationRule({
        data: {
          name: values.name,
          endpointId: values.endpointId,
          enabled: values.enabled,
          marketEventType,
          monitorTargetId
        }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Rule updated' : 'Rule created');
      queryClient.invalidateQueries({ queryKey: notificationRulesQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save rule')
  });

  const form = useAppForm({
    defaultValues: {
      name: rule?.name ?? '',
      endpointId: rule?.endpointId ?? endpointOptions[0]?.value ?? '',
      marketEventType: rule?.marketEventType ?? ANY_MARKET_EVENT_TYPE_VALUE,
      monitorTargetId: rule?.monitorTargetId ?? ANY_MONITOR_TARGET_VALUE,
      enabled: rule?.enabled ?? true
    },
    validators: {
      onSubmit: ruleFormSchema
    },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit notification rule' : 'New notification rule'}</DialogTitle>
          <DialogDescription>
            A rule matches an event type and/or monitor target ("any" when unset) and routes it to
            one endpoint. Event detection and delivery stay separate concepts.
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. price drops to phone' />
              )}
            />
            {isEdit ? (
              <div className='text-sm'>
                <p className='font-medium'>Endpoint</p>
                <p className='text-muted-foreground'>
                  {endpoints.find((endpoint) => endpoint.id === rule.endpointId)?.name ?? 'unknown'}{' '}
                  — cannot be changed after a rule is created.
                </p>
              </div>
            ) : (
              <form.AppField
                name='endpointId'
                children={(field) => (
                  <field.SelectField
                    label='Endpoint'
                    required
                    options={endpointOptions}
                    placeholder='Select endpoint'
                  />
                )}
              />
            )}
            <form.AppField
              name='marketEventType'
              children={(field) => (
                <field.SelectField label='Event type' options={eventTypeOptions} />
              )}
            />
            <form.AppField
              name='monitorTargetId'
              children={(field) => (
                <field.SelectField label='Monitor target' options={monitorTargetOptions} />
              )}
            />
            <form.AppField
              name='enabled'
              children={(field) => (
                <field.SwitchField
                  label='Enabled'
                  description='Disabled rules never match new events.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton disabled={endpointOptions.length === 0}>
                {isEdit ? 'Save changes' : 'Create rule'}
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
