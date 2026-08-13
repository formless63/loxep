import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { FieldGroup } from '@/components/ui/field';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { addManualLine } from '@/server/documents-functions';

const manualLineSchema = z.object({
  description: z.string().trim().min(1, 'Description is required'),
  lineAmount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 12.50'),
  lineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD')
});

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Manual transcription — the ONLY way a receipt/invoice document gets lines
 * this milestone (no OCR/LLM backend ships; OQ3 resolved manual-assisted
 * only). Every hand-typed line reports confidence 1.0 because a human typed
 * it, and defaults to disposition `'expense'` — a SUGGESTION the operator
 * still has to confirm on the review panel above.
 */
export default function ManualLineForm({
  documentId,
  onAdded
}: {
  documentId: string;
  onAdded: () => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof manualLineSchema>) =>
      addManualLine({
        data: {
          documentId,
          description: values.description,
          lineAmount: values.lineAmount,
          lineDate: values.lineDate,
          currency: values.currency.toUpperCase(),
          disposition: 'expense'
        }
      }),
    onSuccess: () => {
      toast.success('Line added');
      void queryClient.invalidateQueries({ queryKey: ['documents'] });
      onAdded();
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not add that line')
  });

  const form = useAppForm({
    defaultValues: {
      description: '',
      lineAmount: '',
      lineDate: todayIsoDate(),
      currency: 'USD'
    } as z.infer<typeof manualLineSchema>,
    validators: { onSubmit: manualLineSchema },
    onSubmit: async ({ value }) => {
      await mutation.mutateAsync(value);
    }
  });

  return (
    <form
      className='space-y-4 rounded-md border p-4'
      onSubmit={(event) => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <p className='text-sm font-medium'>Transcribe a line by hand</p>
      <FieldGroup>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <form.AppField
            name='description'
            children={(field) => <field.TextField label='Description' required />}
          />
          <form.AppField
            name='lineAmount'
            children={(field) => (
              <field.TextField label='Amount' required inputMode='decimal' placeholder='0.00' />
            )}
          />
        </div>
        <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
          <form.AppField
            name='lineDate'
            children={(field) => <field.TextField label='Date' required type='date' />}
          />
          <form.AppField
            name='currency'
            children={(field) => <field.TextField label='Currency' required maxLength={3} />}
          />
        </div>
      </FieldGroup>
      <form.AppForm>
        <form.SubmitButton>Add line</form.SubmitButton>
      </form.AppForm>
    </form>
  );
}
