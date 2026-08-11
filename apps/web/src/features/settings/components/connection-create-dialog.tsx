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

/** `connections.provider` value the eBay OAuth flow (`@/server/ebay-oauth`) accepts. */
const EBAY_PROVIDER = 'ebay';
/** Placeholder `kind` an eBay connection is created with — no per-provider `kind` taxonomy exists yet. */
const EBAY_CONNECTION_KIND = 'marketplace_account';

function parseConfigJson(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isEbayProvider(provider: string): boolean {
  return provider.trim().toLowerCase() === EBAY_PROVIDER;
}

const connectionFormSchema = z
  .object({
    provider: z.string().trim().min(1, 'Provider is required'),
    kind: z.string().trim(),
    name: z.string().trim().min(1, 'Name is required'),
    config: z.string(),
    economicEntityId: z.string()
  })
  .superRefine((values, ctx) => {
    // eBay connections auto-fill kind/config (see EBAY_CONNECTION_KIND) — the
    // shared keyset and OAuth environment live in the eBay integration card,
    // not per-connection config, so nothing to validate here for them.
    if (isEbayProvider(values.provider)) return;
    if (values.kind === '') {
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'Kind is required' });
    }
    if (parseConfigJson(values.config) === null) {
      ctx.addIssue({ code: 'custom', path: ['config'], message: 'Config must be a JSON object' });
    }
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
    mutationFn: (values: ConnectionFormValues) => {
      const ebay = isEbayProvider(values.provider);
      return createConnection({
        data: {
          provider: ebay ? EBAY_PROVIDER : values.provider,
          kind: ebay ? EBAY_CONNECTION_KIND : values.kind,
          name: values.name,
          config: ebay ? {} : (parseConfigJson(values.config) ?? {}),
          economicEntityId:
            values.economicEntityId === NO_ENTITY_VALUE ? null : values.economicEntityId
        }
      });
    },
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
            <form.AppField
              name='provider'
              children={(field) => (
                <field.TextField label='Provider' required placeholder='e.g. ebay' />
              )}
            />
            <form.Subscribe selector={(state) => state.values.provider}>
              {(provider) =>
                isEbayProvider(provider) ? (
                  <div className='rounded-md border p-3 text-sm'>
                    <p className='font-medium'>eBay connection</p>
                    <p className='text-muted-foreground'>
                      Kind and config are set automatically. eBay connections share ONE application
                      keyset and OAuth environment (sandbox/production) — configure it once via the
                      &quot;eBay integration&quot; card above the table. After this connection is
                      created, use its row&apos;s &quot;Connect&quot; action to run the eBay consent
                      flow and bind a user token to it.
                    </p>
                  </div>
                ) : (
                  <form.AppField
                    name='kind'
                    children={(field) => (
                      <field.TextField
                        label='Kind'
                        required
                        placeholder='e.g. marketplace_account'
                      />
                    )}
                  />
                )
              }
            </form.Subscribe>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='Display name' />
              )}
            />
            <form.Subscribe selector={(state) => state.values.provider}>
              {(provider) =>
                isEbayProvider(provider) ? null : (
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
                )
              }
            </form.Subscribe>
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
