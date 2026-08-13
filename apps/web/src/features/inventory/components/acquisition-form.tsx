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
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { acquisitionSourceKindOptions } from '@/features/inventory/constants';
import { createAcquisition } from '@/server/inventory-functions';
import type { AcquisitionSourceKind } from '@/features/inventory/constants';

const DEFAULT_CURRENCY = 'USD';

const acquisitionSchema = z.object({
  title: z.string().trim().min(1, 'A title is required'),
  sourceKind: z.string(),
  vendorName: z.string(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD')
});

type AcquisitionFormValues = z.infer<typeof acquisitionSchema>;

/**
 * "New acquisition" — the direct path (the e2e spec's other route into
 * intake, alongside the `/market` "I bought this" handoff). Blocked the same
 * way as every other write in `@/server/inventory-functions.ts` until
 * `@loxep/inventory` is an `apps/web` dependency.
 */
export default function AcquisitionForm({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: AcquisitionFormValues) =>
      createAcquisition({
        data: {
          title: values.title,
          sourceKind: values.sourceKind as AcquisitionSourceKind,
          currency: values.currency.toUpperCase(),
          vendorName: values.vendorName.trim() === '' ? null : values.vendorName.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Acquisition created');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not create acquisition')
  });

  const form = useAppForm({
    defaultValues: {
      title: '',
      sourceKind: 'thrift_retail',
      vendorName: '',
      currency: DEFAULT_CURRENCY
    } as AcquisitionFormValues,
    validators: { onSubmit: acquisitionSchema },
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
      <DialogContent className='sm:max-w-[440px]'>
        <DialogHeader>
          <DialogTitle>New acquisition</DialogTitle>
          <DialogDescription>
            A lot, however it arrived. Add cost components and unpack items into it afterward.
          </DialogDescription>
        </DialogHeader>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.AppField
              name='title'
              children={(field) => (
                <field.TextField label='Title' required placeholder='e.g. Route 9 estate sale' />
              )}
            />
            <form.AppField
              name='sourceKind'
              children={(field) => (
                <field.SelectField label='Source' required options={acquisitionSourceKindOptions} />
              )}
            />
            <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
              <form.AppField
                name='vendorName'
                children={(field) => <field.TextField label='Vendor' placeholder='e.g. Goodwill' />}
              />
              <form.AppField
                name='currency'
                children={(field) => (
                  <field.TextField label='Currency' required placeholder='USD' maxLength={3} />
                )}
              />
            </div>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>
                <Icons.add />
                Create
              </form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
