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
import { createEntity, updateEntity, type EntityDto } from '@/server/admin-functions';
import { entitiesQuery } from '@/features/settings/api/queries';
import { entityKindOptions, NO_ENTITY_VALUE } from '@/features/settings/constants';

const entityFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  kind: z.string().min(1, 'Kind is required'),
  parentEntityId: z.string(),
  legalName: z.string()
});

type EntityFormValues = z.infer<typeof entityFormSchema>;

/**
 * Create/edit dialog for economic entities (ADR-0017): name, kind from the
 * shared union, optional parent (assumed name beneath an LLC, …), optional
 * legal name. The domain service validates hierarchy (cycles/depth) again
 * server-side.
 */
export default function EntityFormDialog({
  open,
  onOpenChange,
  entity,
  entities
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: EntityDto | null;
  entities: EntityDto[];
}) {
  const queryClient = useQueryClient();
  const isEdit = entity !== null;

  const parentOptions = [
    { value: NO_ENTITY_VALUE, label: 'No parent' },
    ...entities
      .filter((candidate) => candidate.active && candidate.id !== entity?.id)
      .map((candidate) => ({ value: candidate.id, label: candidate.name }))
  ];

  const mutation = useMutation({
    mutationFn: async (values: EntityFormValues) => {
      const parentEntityId =
        values.parentEntityId === NO_ENTITY_VALUE ? null : values.parentEntityId;
      const legalName = values.legalName.trim() === '' ? null : values.legalName.trim();
      if (isEdit) {
        return updateEntity({
          data: {
            id: entity.id,
            name: values.name,
            kind: values.kind as (typeof entityKindOptions)[number]['value'],
            parentEntityId,
            legalName
          }
        });
      }
      return createEntity({
        data: {
          name: values.name,
          kind: values.kind as (typeof entityKindOptions)[number]['value'],
          parentEntityId,
          legalName
        }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Entity updated' : 'Entity created');
      queryClient.invalidateQueries({ queryKey: entitiesQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save entity');
    }
  });

  const form = useAppForm({
    defaultValues: {
      name: entity?.name ?? '',
      kind: entity?.kind ?? '',
      parentEntityId: entity?.parentEntityId ?? NO_ENTITY_VALUE,
      legalName: entity?.legalName ?? ''
    } as EntityFormValues,
    validators: {
      onSubmit: entityFormSchema
    },
    onSubmit: ({ value }) => {
      mutation.mutate(value);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit economic entity' : 'New economic entity'}</DialogTitle>
          <DialogDescription>
            Attribution/business-context record — not a user, permission container, or accounting
            book.
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
                <field.TextField label='Name' required placeholder='e.g. Acme Resale LLC' />
              )}
            />
            <form.AppField
              name='kind'
              children={(field) => (
                <field.SelectField
                  label='Kind'
                  required
                  options={entityKindOptions}
                  placeholder='Select kind'
                  description='Descriptive only — encodes no tax or legal conclusion.'
                />
              )}
            />
            <form.AppField
              name='parentEntityId'
              children={(field) => (
                <field.SelectField
                  label='Parent entity'
                  options={parentOptions}
                  placeholder='No parent'
                />
              )}
            />
            <form.AppField
              name='legalName'
              children={(field) => (
                <field.TextField label='Legal name' placeholder='Optional registered legal name' />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create entity'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
