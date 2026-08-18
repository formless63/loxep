import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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
import { useAppForm } from '@/lib/form';
import { createCatalogItem, updateCatalogItem } from '@/server/commerce-functions';
import { catalogItemsQuery } from '@/features/commerce/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { UNATTRIBUTED_ENTITY_VALUE } from '@/features/finance/constants';
import type { CatalogItemListItemDto } from '@/server/commerce-functions';

const NO_CURRENCY_VALUE = '__none__';

const catalogItemFormSchema = z.object({
  sku: z.string().trim().min(1, 'SKU is required'),
  name: z.string().trim().min(1, 'Name is required'),
  kind: z.enum(['simple', 'variant_group']),
  status: z.enum(['draft', 'active', 'archived']),
  economicEntityId: z.string(),
  defaultCurrency: z.string(),
  defaultPrice: z.string()
});

type CatalogItemFormValues = z.infer<typeof catalogItemFormSchema>;

/**
 * `CatalogService.createCatalogItem`/`updateCatalogItem` (loxep-7fs, A22) —
 * `/commerce/catalog` was strictly read-only before this pass (items only
 * ever minted implicitly at manual-listing time). SKU is immutable after
 * creation — `catalog_items.sku` is unique installation-wide, and letting an
 * operator rename it after order lines reference it would sever that trail.
 */
export default function CatalogItemFormDialog({
  open,
  onOpenChange,
  item
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: CatalogItemListItemDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = item !== null;
  const { data: entities } = useQuery({ ...entitiesQuery, enabled: open });
  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...(entities ?? []).map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  const mutation = useMutation({
    mutationFn: (values: CatalogItemFormValues) => {
      const economicEntityId =
        values.economicEntityId === UNATTRIBUTED_ENTITY_VALUE ? null : values.economicEntityId;
      const defaultCurrency =
        values.defaultCurrency === NO_CURRENCY_VALUE ? null : values.defaultCurrency;
      const defaultPrice = values.defaultPrice.trim() === '' ? null : values.defaultPrice.trim();
      if (isEdit) {
        return updateCatalogItem({
          data: {
            id: item.id,
            name: values.name,
            status: values.status,
            economicEntityId,
            defaultCurrency,
            defaultPrice
          }
        });
      }
      return createCatalogItem({
        data: {
          sku: values.sku.trim(),
          name: values.name,
          kind: values.kind,
          status: values.status,
          economicEntityId,
          defaultCurrency,
          defaultPrice
        }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Catalog item updated' : 'Catalog item created');
      void queryClient.invalidateQueries({ queryKey: catalogItemsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save catalog item');
    }
  });

  const form = useAppForm({
    defaultValues: {
      sku: item?.sku ?? '',
      name: item?.name ?? '',
      kind: (item?.kind === 'variant_group' ? 'variant_group' : 'simple') as
        | 'simple'
        | 'variant_group',
      status: (item?.status ?? 'active') as 'draft' | 'active' | 'archived',
      economicEntityId: item?.economicEntityId ?? UNATTRIBUTED_ENTITY_VALUE,
      defaultCurrency: item?.defaultCurrency ?? NO_CURRENCY_VALUE,
      defaultPrice: item?.defaultPrice ?? ''
    } as CatalogItemFormValues,
    validators: { onSubmit: catalogItemFormSchema },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[480px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {isEdit ? 'Edit catalog item' : 'New catalog item'}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Loxep's internal SKU identity — exists before it is ever listed or sold.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
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
                <p className='font-medium'>SKU</p>
                <p className='text-muted-foreground'>
                  {item.sku} — unique installation-wide, cannot be changed after creation.
                </p>
              </div>
            ) : (
              <form.AppField
                name='sku'
                children={(field) => (
                  <field.TextField label='SKU' required placeholder='e.g. RADIO-1947-001' />
                )}
              />
            )}
            <form.AppField
              name='name'
              children={(field) => <field.TextField label='Name' required />}
            />
            {!isEdit && (
              <form.AppField
                name='kind'
                children={(field) => (
                  <field.SelectField
                    label='Kind'
                    required
                    options={[
                      { value: 'simple', label: 'Simple — one sellable thing' },
                      { value: 'variant_group', label: 'Variant group — parent of variants' }
                    ]}
                  />
                )}
              />
            )}
            <form.AppField
              name='status'
              children={(field) => (
                <field.SelectField
                  label='Status'
                  required
                  options={[
                    { value: 'draft', label: 'Draft' },
                    { value: 'active', label: 'Active' },
                    { value: 'archived', label: 'Archived' }
                  ]}
                />
              )}
            />
            <form.AppField
              name='economicEntityId'
              children={(field) => (
                <field.SelectField label='Attribution' options={entityOptions} />
              )}
            />
            <div className='grid grid-cols-2 gap-6'>
              <form.AppField
                name='defaultCurrency'
                children={(field) => (
                  <field.SelectField
                    label='Default currency'
                    options={[
                      { value: NO_CURRENCY_VALUE, label: 'None' },
                      { value: 'USD', label: 'USD' },
                      { value: 'EUR', label: 'EUR' },
                      { value: 'GBP', label: 'GBP' },
                      { value: 'CAD', label: 'CAD' },
                      { value: 'AUD', label: 'AUD' }
                    ]}
                  />
                )}
              />
              <form.AppField
                name='defaultPrice'
                children={(field) => (
                  <field.TextField label='Default price' placeholder='e.g. 24.99' />
                )}
              />
            </div>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create item'}
            </Button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
