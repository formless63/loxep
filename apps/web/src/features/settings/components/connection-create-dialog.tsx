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
import { createConnection, type EntityDto } from '@/server/admin-functions';
import { connectionsQuery } from '@/features/settings/api/queries';
import { NO_ENTITY_VALUE } from '@/features/settings/constants';

function parseConfigJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const connectionFormSchema = z.object({
  provider: z.string().trim().min(1, 'Provider is required'),
  kind: z.string().trim().min(1, 'Kind is required'),
  name: z.string().trim().min(1, 'Name is required'),
  config: z.string().refine((value) => parseConfigJson(value) !== null, {
    message: 'Config must be a JSON object'
  }),
  economicEntityId: z.string()
});

type ConnectionFormValues = z.infer<typeof connectionFormSchema>;

/**
 * Create dialog for connections. Non-secret config only — credential entry
 * arrives with the Phase 1 provider flows; attribution is business context,
 * never authorization (ADR-0017).
 */
export default function ConnectionCreateDialog({
  open,
  onOpenChange,
  entities
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entities: EntityDto[];
}) {
  const queryClient = useQueryClient();

  const entityOptions = [
    { value: NO_ENTITY_VALUE, label: 'No attribution' },
    ...entities
      .filter((entity) => entity.active)
      .map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  const mutation = useMutation({
    mutationFn: (values: ConnectionFormValues) =>
      createConnection({
        data: {
          provider: values.provider,
          kind: values.kind,
          name: values.name,
          config: parseConfigJson(values.config) ?? {},
          economicEntityId:
            values.economicEntityId === NO_ENTITY_VALUE ? null : values.economicEntityId
        }
      }),
    onSuccess: () => {
      toast.success('Connection created');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to create connection');
    }
  });

  const form = useAppForm({
    defaultValues: {
      provider: '',
      kind: '',
      name: '',
      config: '{}',
      economicEntityId: NO_ENTITY_VALUE
    } as ConnectionFormValues,
    validators: {
      onSubmit: connectionFormSchema
    },
    onSubmit: ({ value }) => {
      mutation.mutate(value);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>New connection</DialogTitle>
          <DialogDescription>
            One configured relationship to an external account/store/service. Credential entry is
            part of the Phase 1 provider flows — this records the connection itself.
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
            <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
              <form.AppField
                name='provider'
                children={(field) => (
                  <field.TextField label='Provider' required placeholder='e.g. ebay' />
                )}
              />
              <form.AppField
                name='kind'
                children={(field) => (
                  <field.TextField label='Kind' required placeholder='e.g. marketplace_account' />
                )}
              />
            </div>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='Display name' />
              )}
            />
            <form.AppField
              name='config'
              children={(field) => (
                <field.TextareaField
                  label='Config (JSON)'
                  required
                  rows={4}
                  placeholder='{}'
                  description='Non-secret provider configuration as a JSON object.'
                />
              )}
            />
            <form.AppField
              name='economicEntityId'
              children={(field) => (
                <field.SelectField
                  label='Economic entity'
                  options={entityOptions}
                  placeholder='No attribution'
                  description='Business context only — grants and restricts nothing.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              Create connection
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
