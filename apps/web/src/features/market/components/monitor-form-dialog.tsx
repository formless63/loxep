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
import { useAppForm } from '@/lib/form';
import { createMonitor, updateMonitor, type MonitorDto } from '@/server/market-functions';
import { ebayConnectionOptionsQuery, monitorsQuery } from '@/features/market/api/queries';
import {
  monitorTargetTypeLabel,
  monitorTargetTypeOptions,
  NO_CONNECTION_VALUE
} from '@/features/market/constants';

const monitorFormSchema = z
  .object({
    targetType: z.enum(['ebay_item', 'ebay_watchlist', 'ebay_search', 'ebay_seller']),
    name: z.string().trim().min(1, 'Name is required'),
    connectionId: z.string(),
    externalItemId: z.string(),
    query: z.string(),
    categoryId: z.string(),
    sellerUsername: z.string(),
    intervalSeconds: z.number({ error: 'Interval is required' }).int().positive(),
    priority: z.number({ error: 'Priority is required' }).int(),
    enabled: z.boolean()
  })
  .superRefine((values, ctx) => {
    if (values.targetType === 'ebay_item' && values.externalItemId.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['externalItemId'],
        message: 'External item id is required for an eBay item monitor'
      });
    }
    if (values.targetType === 'ebay_watchlist' && values.connectionId === NO_CONNECTION_VALUE) {
      ctx.addIssue({
        code: 'custom',
        path: ['connectionId'],
        message: 'A connection is required to identify the watchlist'
      });
    }
    if (
      values.targetType === 'ebay_search' &&
      values.query.trim() === '' &&
      values.categoryId.trim() === ''
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'A search monitor needs a query or a category'
      });
    }
    if (values.targetType === 'ebay_seller' && values.sellerUsername.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['sellerUsername'],
        message: 'Seller username is required for an eBay seller monitor'
      });
    }
  });

type MonitorFormValues = z.infer<typeof monitorFormSchema>;

/**
 * Create/edit dialog for monitor targets (loxep-62y.4.1): type determines
 * which fields apply — `ebay_item` needs `externalItemId` and an optional
 * connection, `ebay_watchlist` is identified entirely by its connection.
 * Type is immutable after creation, same convention as the notification
 * rule dialog's endpoint field.
 */
export default function MonitorFormDialog({
  open,
  onOpenChange,
  monitor
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  monitor: MonitorDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = monitor !== null;
  const { data: connections } = useQuery(ebayConnectionOptionsQuery);
  const connectionOptions = [
    { value: NO_CONNECTION_VALUE, label: 'No connection' },
    ...(connections ?? []).map((connection) => ({ value: connection.id, label: connection.name }))
  ];

  const mutation = useMutation({
    mutationFn: (values: MonitorFormValues) => {
      const connectionId = values.connectionId === NO_CONNECTION_VALUE ? null : values.connectionId;
      const query = values.query.trim();
      const categoryId = values.categoryId.trim();
      if (isEdit) {
        return updateMonitor({
          data: {
            id: monitor.id,
            name: values.name,
            connectionId,
            intervalSeconds: values.intervalSeconds,
            priority: values.priority,
            enabled: values.enabled,
            ...(monitor.targetType === 'ebay_item'
              ? { externalItemId: values.externalItemId.trim() }
              : {}),
            ...(monitor.targetType === 'ebay_search' || monitor.targetType === 'ebay_seller'
              ? {
                  ...(query !== '' ? { query } : {}),
                  ...(categoryId !== '' ? { categoryId } : {})
                }
              : {}),
            ...(monitor.targetType === 'ebay_seller'
              ? { sellerUsername: values.sellerUsername.trim() }
              : {})
          }
        });
      }
      switch (values.targetType) {
        case 'ebay_item':
          return createMonitor({
            data: {
              targetType: 'ebay_item',
              name: values.name,
              connectionId,
              intervalSeconds: values.intervalSeconds,
              priority: values.priority,
              enabled: values.enabled,
              externalItemId: values.externalItemId.trim()
            }
          });
        case 'ebay_search':
          return createMonitor({
            data: {
              targetType: 'ebay_search',
              name: values.name,
              connectionId,
              intervalSeconds: values.intervalSeconds,
              priority: values.priority,
              enabled: values.enabled,
              ...(query !== '' ? { query } : {}),
              ...(categoryId !== '' ? { categoryId } : {})
            }
          });
        case 'ebay_seller':
          return createMonitor({
            data: {
              targetType: 'ebay_seller',
              name: values.name,
              connectionId,
              intervalSeconds: values.intervalSeconds,
              priority: values.priority,
              enabled: values.enabled,
              // Validated non-empty by superRefine above.
              sellerUsername: values.sellerUsername.trim(),
              ...(query !== '' ? { query } : {}),
              ...(categoryId !== '' ? { categoryId } : {})
            }
          });
        case 'ebay_watchlist':
        default:
          return createMonitor({
            data: {
              targetType: 'ebay_watchlist',
              name: values.name,
              // Validated non-empty (not the sentinel) by superRefine above.
              connectionId: connectionId as string,
              intervalSeconds: values.intervalSeconds,
              priority: values.priority,
              enabled: values.enabled
            }
          });
      }
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Monitor updated' : 'Monitor created');
      queryClient.invalidateQueries({ queryKey: monitorsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save monitor');
    }
  });

  const config = (monitor?.config ?? {}) as {
    externalItemId?: string;
    query?: string;
    categoryId?: string;
    sellerUsername?: string;
  };

  const form = useAppForm({
    defaultValues: {
      targetType: monitor?.targetType ?? 'ebay_item',
      name: monitor?.name ?? '',
      connectionId: monitor?.connectionId ?? NO_CONNECTION_VALUE,
      externalItemId: config.externalItemId ?? '',
      query: config.query ?? '',
      categoryId: config.categoryId ?? '',
      sellerUsername: config.sellerUsername ?? '',
      intervalSeconds: monitor?.intervalSeconds ?? 3600,
      priority: monitor?.priority ?? 0,
      enabled: monitor?.enabled ?? true
    } as MonitorFormValues,
    validators: {
      onSubmit: monitorFormSchema
    },
    onSubmit: ({ value }) => {
      mutation.mutate(value);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit monitor' : 'New monitor'}</DialogTitle>
          <DialogDescription>
            Scheduling state — interval, priority, backoff — lives in the database; a small number
            of dispatcher jobs claim due monitors (ADR-0003), never one cron entry per item.
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
            {isEdit ? (
              <div className='text-sm'>
                <p className='font-medium'>Type</p>
                <p className='text-muted-foreground'>
                  {monitorTargetTypeLabel(monitor.targetType)} — cannot be changed after a monitor
                  is created.
                </p>
              </div>
            ) : (
              <form.AppField
                name='targetType'
                children={(field) => (
                  <field.SelectField label='Type' required options={monitorTargetTypeOptions} />
                )}
              />
            )}
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. Vintage radio watchlist' />
              )}
            />
            <form.Subscribe selector={(state) => state.values.targetType}>
              {(targetType) => (
                <>
                  {targetType === 'ebay_item' && (
                    <form.AppField
                      name='externalItemId'
                      children={(field) => (
                        <field.TextField
                          label='eBay item id'
                          required
                          placeholder='e.g. 123456789012'
                          description='The external eBay item id this monitor polls.'
                        />
                      )}
                    />
                  )}
                  {targetType === 'ebay_seller' && (
                    <form.AppField
                      name='sellerUsername'
                      children={(field) => (
                        <field.TextField
                          label='Seller username'
                          required
                          placeholder='e.g. vintage-radios-co'
                          description='Every currently purchasable listing of this eBay seller.'
                        />
                      )}
                    />
                  )}
                  {(targetType === 'ebay_search' || targetType === 'ebay_seller') && (
                    <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
                      <form.AppField
                        name='query'
                        children={(field) => (
                          <field.TextField
                            label='Query'
                            required={targetType === 'ebay_search'}
                            placeholder='e.g. vintage radio'
                            description={
                              targetType === 'ebay_search'
                                ? 'Search keywords — a query or a category is required.'
                                : 'Optional keyword narrowing within this seller’s listings.'
                            }
                          />
                        )}
                      />
                      <form.AppField
                        name='categoryId'
                        children={(field) => (
                          <field.TextField
                            label='Category id'
                            placeholder='e.g. 293'
                            description='Optional eBay category id narrowing.'
                          />
                        )}
                      />
                    </div>
                  )}
                  <form.AppField
                    name='connectionId'
                    children={(field) => (
                      <field.SelectField
                        label='Connection'
                        required={targetType === 'ebay_watchlist'}
                        options={connectionOptions}
                        placeholder='No connection'
                        description={
                          targetType === 'ebay_watchlist'
                            ? 'The eBay connection whose watchlist this monitor polls.'
                            : 'Optional — the eBay connection/account used to poll this item.'
                        }
                      />
                    )}
                  />
                </>
              )}
            </form.Subscribe>
            <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
              <form.AppField
                name='intervalSeconds'
                children={(field) => (
                  <field.TextField
                    label='Base interval (seconds)'
                    required
                    type='number'
                    min={1}
                    description='Operator-set base cadence; adaptive polling may speed up or slow down around it.'
                  />
                )}
              />
              <form.AppField
                name='priority'
                children={(field) => (
                  <field.TextField
                    label='Priority'
                    required
                    type='number'
                    description='Smaller claims first when the dispatcher claims due work.'
                  />
                )}
              />
            </div>
            <form.AppField
              name='enabled'
              children={(field) => (
                <field.SwitchField
                  label='Enabled'
                  description='Disabled monitors are never claimed by the dispatcher.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create monitor'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
