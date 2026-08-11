import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { useAppForm } from '@/lib/form';
import {
  createNotificationEndpoint,
  updateNotificationEndpoint,
  type NotificationEndpointDto
} from '@/server/admin-functions';
import { notificationEndpointsQuery } from '@/features/settings/api/queries';
import { ntfyPriorityOptions } from '@/features/settings/constants';

const NO_PRIORITY_VALUE = '__default__';

const endpointFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  baseUrl: z.string().refine((value) => z.url().safeParse(value).success, {
    message: 'Base URL must be a valid URL'
  }),
  topic: z
    .string()
    .trim()
    .min(1, 'Topic is required')
    .regex(/^[-_A-Za-z0-9]+$/, 'ntfy topics may contain only letters, digits, - and _'),
  priority: z.string(),
  enabled: z.boolean(),
  token: z.string()
});

type EndpointFormValues = z.infer<typeof endpointFormSchema>;

/**
 * Create/edit dialog for ntfy notification endpoints. The access token is
 * write-only: it is sent once, stored through the encrypted secrets service
 * (ADR-0019), and never echoed back by any read surface — the edit form
 * leaves it blank and only rotates the stored token when a new value is
 * typed.
 */
export default function NotificationEndpointDialog({
  open,
  onOpenChange,
  endpoint
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: NotificationEndpointDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = endpoint !== null;

  const priorityOptions = [
    { value: NO_PRIORITY_VALUE, label: 'ntfy default' },
    ...ntfyPriorityOptions
  ];

  const mutation = useMutation({
    mutationFn: (values: EndpointFormValues) => {
      const config = {
        baseUrl: values.baseUrl.trim(),
        topic: values.topic.trim(),
        ...(values.priority === NO_PRIORITY_VALUE
          ? {}
          : { priority: values.priority as (typeof ntfyPriorityOptions)[number]['value'] })
      };
      const token = values.token.trim() === '' ? undefined : values.token.trim();
      if (isEdit) {
        return updateNotificationEndpoint({
          data: { id: endpoint.id, name: values.name, config, enabled: values.enabled, token }
        });
      }
      return createNotificationEndpoint({
        data: { name: values.name, config, enabled: values.enabled, token }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Endpoint updated' : 'Endpoint created');
      queryClient.invalidateQueries({ queryKey: notificationEndpointsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save endpoint');
    }
  });

  const form = useAppForm({
    defaultValues: {
      name: endpoint?.name ?? '',
      baseUrl: endpoint?.config.baseUrl ?? 'https://ntfy.sh',
      topic: endpoint?.config.topic ?? '',
      priority: endpoint?.config.priority ?? NO_PRIORITY_VALUE,
      enabled: endpoint?.enabled ?? true,
      token: ''
    } as EndpointFormValues,
    validators: {
      onSubmit: endpointFormSchema
    },
    onSubmit: ({ value }) => {
      mutation.mutate(value);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Edit notification endpoint' : 'New notification endpoint'}
          </DialogTitle>
          <DialogDescription>
            An endpoint is one delivery destination that rules can route events to. ntfy is the
            first supported endpoint type: a server base URL plus a topic.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-6'
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. phone alerts' />
              )}
            />
            <form.AppField
              name='baseUrl'
              children={(field) => (
                <field.TextField
                  label='Base URL'
                  required
                  placeholder='https://ntfy.sh'
                  description='The ntfy server root — self-hosted or https://ntfy.sh.'
                />
              )}
            />
            <form.AppField
              name='topic'
              children={(field) => (
                <field.TextField
                  label='Topic'
                  required
                  placeholder='loxep-alerts'
                  description='ntfy topics are letters, digits, - and _ only.'
                />
              )}
            />
            <form.AppField
              name='priority'
              children={(field) => <field.SelectField label='Priority' options={priorityOptions} />}
            />
            <form.AppField
              name='token'
              children={(field) => (
                <field.TextField
                  label='Access token'
                  type='password'
                  autoComplete='new-password'
                  placeholder={isEdit && endpoint.hasToken ? '•••••••• (unchanged)' : 'Optional'}
                  description='Write-only: stored encrypted, never displayed again. Leave blank to keep the current token.'
                />
              )}
            />
            <form.AppField
              name='enabled'
              children={(field) => (
                <field.SwitchField
                  label='Enabled'
                  description='Disabled endpoints are skipped by delivery.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create endpoint'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
