import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { useAppForm } from '@/lib/form';
import { toastError } from '@/lib/errors';
import {
  removeInventoryItemSpecific,
  setInventoryItemSpecific
} from '@/server/inventory-functions';
import type { ItemSpecificDto } from '@/server/inventory-functions';

const addSpecificSchema = z.object({
  name: z.string().trim().min(1, 'A name is required'),
  value: z.string().trim().min(1, 'A value is required'),
  unit: z.string().trim()
});

/**
 * Typed key/value product specifics (M3, loxep-dgf.3): add and remove rows
 * over `@loxep/inventory`'s `SpecificsService`. Multi-value falls out of the
 * key — the same name may appear on several rows with different values
 * (`Color: Black`, `Color: Chrome`), so this renders every row rather than
 * grouping by name. `source` is shown as a badge so a `channel_suggested` or
 * `parsed` row reads differently from one the operator typed.
 */
export default function SpecificsEditor({
  inventoryItemId,
  specifics
}: {
  inventoryItemId: string;
  specifics: ItemSpecificDto[];
}) {
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['inventory', 'item', inventoryItemId] });

  const addMutation = useMutation({
    mutationFn: (input: { name: string; value: string; unit: string }) =>
      setInventoryItemSpecific({
        data: {
          inventoryItemId,
          name: input.name,
          value: input.value,
          unit: input.unit.trim() === '' ? null : input.unit.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Specific added');
      void invalidate();
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not add specific')
  });

  const removeMutation = useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      removeInventoryItemSpecific({ data: { inventoryItemId, ...input } }),
    onSuccess: () => {
      toast.success('Specific removed');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Could not remove specific')
  });

  const form = useAppForm({
    defaultValues: { name: '', value: '', unit: '' },
    validators: { onSubmit: addSpecificSchema },
    onSubmit: async ({ value }) => {
      try {
        await addMutation.mutateAsync(value);
      } catch {
        // Reported through addMutation.onError's toast.
      }
    }
  });

  return (
    <div className='flex flex-col gap-3'>
      {specifics.length === 0 ? (
        <Empty className='py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.product />
            </EmptyMedia>
            <EmptyTitle>No specifics yet</EmptyTitle>
            <EmptyDescription>
              Brand, size, shutter count — whatever this unit's listing will need.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className='flex flex-col gap-2'>
          {specifics.map((specific) => (
            <li
              key={specific.id}
              className='flex items-center justify-between gap-3 rounded-lg border p-2 px-3'
            >
              <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm'>
                <span className='font-medium'>{specific.name}</span>
                <span className='text-muted-foreground'>
                  {specific.value}
                  {specific.unit ? ` ${specific.unit}` : ''}
                </span>
                {specific.source !== 'manual' && (
                  <Badge variant='outline'>{specific.source.replace(/_/g, ' ')}</Badge>
                )}
              </div>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                aria-label={`Remove ${specific.name}`}
                disabled={removeMutation.isPending}
                onClick={() =>
                  removeMutation.mutate({ name: specific.name, value: specific.value })
                }
              >
                <Icons.trash />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <form
        className='grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto_auto]'
        onSubmit={(event) => {
          event.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.AppField
          name='name'
          children={(field) => <field.TextField label='Name' placeholder='e.g. Brand' />}
        />
        <form.AppField
          name='value'
          children={(field) => <field.TextField label='Value' placeholder='e.g. Nikon' />}
        />
        <form.AppField
          name='unit'
          children={(field) => <field.TextField label='Unit' placeholder='optional' />}
        />
        <form.AppForm>
          <form.SubmitButton>
            <Icons.add />
            Add
          </form.SubmitButton>
        </form.AppForm>
      </form>
    </div>
  );
}
