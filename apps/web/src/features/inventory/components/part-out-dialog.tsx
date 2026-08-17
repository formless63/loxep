import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Field, FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { partOutInventoryItem } from '@/server/inventory-functions';

const childSchema = z.object({
  label: z.string().trim().min(1, 'A description is required'),
  quantity: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive quantity, e.g. 1'),
  weight: z.string().trim()
});

const partOutSchema = z.object({
  children: z.array(childSchema).min(1, 'Add at least one child item')
});

/**
 * The part-out operation (M3, loxep-dgf.3) — `ItemsService.partOut`. Breaks
 * this unit into N child rows, dividing its basis across them by weight
 * (defaulting to each child's own quantity when no weight is given) and
 * depleting this row entirely. Irreversible: once submitted, `sale_mode`
 * becomes `'parted_out'` and cannot be hand-edited back.
 */
export default function PartOutDialog({
  open,
  onOpenChange,
  inventoryItemId,
  itemCode
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  inventoryItemId: string;
  itemCode: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const mutation = useMutation({
    mutationFn: (children: { label: string; quantity: string; weight: string }[]) =>
      partOutInventoryItem({
        data: {
          id: inventoryItemId,
          children: children.map((child) => ({
            label: child.label,
            quantity: child.quantity,
            ...(child.weight.trim() === '' ? {} : { weight: child.weight })
          }))
        }
      }),
    onSuccess: async (result) => {
      toast.success(`Parted out into ${result.childCodes.join(', ')}`);
      await queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
      await navigate({ to: '/inventory/stock/$id', params: { id: result.parentId } });
    },
    onError: (error) => toastError(error, 'Could not part out this item')
  });

  const form = useAppForm({
    defaultValues: {
      children: [{ label: '', quantity: '1', weight: '' }]
    },
    validators: { onSubmit: partOutSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value.children);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[560px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Part out {itemCode}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Breaks this unit into the children listed below, divides its cost basis across them, and
            depletes this row. This cannot be undone from here.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          className='space-y-4'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <form.Field
            name='children'
            mode='array'
            children={(field) => (
              <div className='flex flex-col gap-3'>
                {field.state.value.map((_, index) => (
                  <div key={index} className='grid grid-cols-[1fr_6rem_6rem_auto] items-end gap-2'>
                    <form.Field
                      name={`children[${index}].label`}
                      children={(subField) => {
                        const invalid =
                          subField.state.meta.isTouched && !subField.state.meta.isValid;
                        return (
                          <Field data-invalid={invalid}>
                            <Input
                              placeholder='e.g. screen'
                              value={subField.state.value}
                              onChange={(e) => subField.handleChange(e.target.value)}
                              onBlur={subField.handleBlur}
                              aria-label={`Child ${index + 1} description`}
                              aria-invalid={invalid}
                            />
                            {invalid && <FieldError errors={subField.state.meta.errors} />}
                          </Field>
                        );
                      }}
                    />
                    <form.Field
                      name={`children[${index}].quantity`}
                      children={(subField) => (
                        <Field>
                          <Input
                            inputMode='decimal'
                            value={subField.state.value}
                            onChange={(e) => subField.handleChange(e.target.value)}
                            onBlur={subField.handleBlur}
                            aria-label={`Child ${index + 1} quantity`}
                          />
                        </Field>
                      )}
                    />
                    <form.Field
                      name={`children[${index}].weight`}
                      children={(subField) => (
                        <Field>
                          <Input
                            inputMode='decimal'
                            placeholder='basis weight'
                            value={subField.state.value}
                            onChange={(e) => subField.handleChange(e.target.value)}
                            onBlur={subField.handleBlur}
                            aria-label={`Child ${index + 1} basis weight`}
                          />
                        </Field>
                      )}
                    />
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      aria-label={`Remove child ${index + 1}`}
                      disabled={field.state.value.length <= 1}
                      onClick={() => field.removeValue(index)}
                    >
                      <Icons.close />
                    </Button>
                  </div>
                ))}
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => field.pushValue({ label: '', quantity: '1', weight: '' })}
                >
                  <Icons.add />
                  Add child
                </Button>
              </div>
            )}
          />

          <ResponsiveDialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton variant='destructive'>Part out</form.SubmitButton>
            </form.AppForm>
          </ResponsiveDialogFooter>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
