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
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { formatMoney } from '@/lib/format';
import { addExpenseLine, removeExpenseLine } from '@/server/expense-functions';
import type { ExpenseLineDto, ExpenseLinesSummaryDto } from '@/server/expense-functions';
import { expenseLineKindLabel, expenseLineKindOptions } from '@/features/finance/constants';

const addLineSchema = z.object({
  description: z.string().trim(),
  quantity: z.string().trim(),
  unitAmount: z.string().trim(),
  lineAmount: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d{1,6})?$/, 'Enter an amount, e.g. 12.50'),
  lineKind: z.enum(['item', 'shipping', 'tax', 'fee', 'discount', 'other'])
});

/**
 * `expense_lines` on the detail page (loxep-cd3.3, M3) — WHAT WAS BOUGHT,
 * rendered and edited separately from allocations (WHERE THE MONEY IS
 * CHARGED), which this card never touches or merges with. Add/remove rows
 * mirror `SpecificsEditor`'s (`@/features/inventory/components/
 * specifics-editor.tsx`) precedent: the expense already exists here, so
 * each add/remove is its own server round trip against `@loxep/accounting`'s
 * `ExpenseLinesService` (draft-only — the add form and remove buttons hide
 * once the expense is recorded, matching the allocation lock's own posture).
 */
export default function ExpenseLinesCard({
  expenseId,
  currency,
  status,
  lines,
  summary
}: {
  expenseId: string;
  currency: string;
  status: string;
  lines: ExpenseLineDto[];
  summary: ExpenseLinesSummaryDto;
}) {
  const queryClient = useQueryClient();
  const editable = status === 'draft';

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['finance', 'expense', expenseId] });

  const addMutation = useMutation({
    mutationFn: (input: {
      description: string;
      quantity: string;
      unitAmount: string;
      lineAmount: string;
      lineKind: string;
    }) =>
      addExpenseLine({
        data: {
          expenseId,
          description: input.description.trim() === '' ? null : input.description.trim(),
          quantity: input.quantity.trim() === '' ? null : input.quantity.trim(),
          unitAmount: input.unitAmount.trim() === '' ? null : input.unitAmount.trim(),
          lineAmount: input.lineAmount.trim(),
          lineKind: input.lineKind as never
        }
      }),
    onSuccess: () => {
      toast.success('Line added');
      void invalidate();
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not add line')
  });

  const removeMutation = useMutation({
    mutationFn: (lineId: string) => removeExpenseLine({ data: { lineId } }),
    onSuccess: () => {
      toast.success('Line removed');
      void invalidate();
    },
    onError: (error) => toastError(error, 'Could not remove line')
  });

  const form = useAppForm({
    defaultValues: {
      description: '',
      quantity: '',
      unitAmount: '',
      lineAmount: '',
      lineKind: 'item'
    } as z.infer<typeof addLineSchema>,
    validators: { onSubmit: addLineSchema },
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
      <div className='flex items-center justify-between'>
        <h3 className='text-sm font-medium'>Line items</h3>
        {summary.lineCount > 0 && (
          <span className='text-muted-foreground text-xs'>
            {summary.lineCount} line(s) · {formatMoney(summary.absoluteLineTotal, currency)} total
          </span>
        )}
      </div>

      {lines.length === 0 ? (
        <Empty className='py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.fees />
            </EmptyMedia>
            <EmptyTitle>No line items yet</EmptyTitle>
            <EmptyDescription>
              What was on the receipt, not where the money is charged — a headline-only expense
              stays valid without any.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className='flex flex-col gap-2'>
          {lines.map((line) => (
            <li
              key={line.id}
              className='flex items-center justify-between gap-3 rounded-lg border p-2 px-3'
            >
              <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm'>
                <span className='font-medium'>{line.description ?? '—'}</span>
                {line.quantity !== null && line.unitAmount !== null && (
                  <span className='text-muted-foreground'>
                    {line.quantity} × {formatMoney(line.unitAmount, currency)}
                  </span>
                )}
                <span className='tabular-nums'>{formatMoney(line.lineAmount, currency)}</span>
                {line.lineKind !== 'item' && (
                  <Badge variant='outline'>{expenseLineKindLabel(line.lineKind)}</Badge>
                )}
              </div>
              {editable && (
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={`Remove line: ${line.description ?? formatMoney(line.lineAmount, currency)}`}
                  disabled={removeMutation.isPending}
                  onClick={() => removeMutation.mutate(line.id)}
                >
                  <Icons.trash />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <form
          className='grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_5rem_6rem_6rem_8rem_auto]'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup className='contents'>
            <form.AppField
              name='description'
              children={(field) => (
                <field.TextField label='Description' placeholder='e.g. Packing tape' />
              )}
            />
            <form.AppField
              name='quantity'
              children={(field) => <field.TextField label='Quantity' placeholder='qty' />}
            />
            <form.AppField
              name='unitAmount'
              children={(field) => <field.TextField label='Unit amount' placeholder='unit' />}
            />
            <form.AppField
              name='lineAmount'
              children={(field) => <field.TextField label='Amount' required placeholder='0.00' />}
            />
            <form.AppField
              name='lineKind'
              children={(field) => (
                <field.SelectField label='Kind' options={expenseLineKindOptions} />
              )}
            />
          </FieldGroup>
          <form.AppForm>
            <form.SubmitButton>
              <Icons.add />
              Add
            </form.SubmitButton>
          </form.AppForm>
        </form>
      )}
    </div>
  );
}
