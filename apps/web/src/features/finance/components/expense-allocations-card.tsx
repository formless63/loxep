import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import {
  addExpenseAllocation,
  fetchExpenseAllocations,
  removeExpenseAllocation
} from '@/server/expense-functions';
import { entitiesQuery } from '@/features/settings/api/queries';

const NO_ALLOCATION_ENTITY_VALUE = '__none__';

const addAllocationSchema = z
  .object({
    amount: z
      .string()
      .trim()
      .regex(/^-?\d+(\.\d{1,6})?$/, 'Enter an amount, e.g. 12.50'),
    economicEntityId: z.string(),
    channel: z.string().trim(),
    note: z.string().trim()
  })
  .refine(
    (value) => value.economicEntityId !== NO_ALLOCATION_ENTITY_VALUE || value.channel !== '',
    {
      message: 'Name a target — an entity or a channel',
      path: ['channel']
    }
  );

type AddAllocationFormValues = z.infer<typeof addAllocationSchema>;

/**
 * A5 (loxep-wx3) — `listAllocations`/`addAllocation`/`removeAllocation`
 * (`@loxep/accounting/expenses.ts:422-436`) had zero callers; only
 * `allocationSummary` (the totals) was ever read, and `/finance/overview`'s
 * "Unallocated expenses" table linked here with nothing to land on. Sibling
 * to `ExpenseLinesCard` — same add/remove-as-its-own-round-trip shape,
 * same draft-only gate mirroring the service's own `assertEditable` lock.
 *
 * An allocation is WHERE THE MONEY IS CHARGED (economic entity or channel),
 * never WHAT WAS BOUGHT (`expense_lines`, the sibling card above) — the two
 * are never merged. `allocationSchema` (`@loxep/accounting`) accepts several
 * orthogonal targets (entity, acquisition, catalog item, channel, ledger
 * account, dimension value); this card exposes the two an operator can pick
 * without a separate identity-resolving combobox — economic entity (already
 * listed on this page) and free-text channel. Acquisition/catalog-item/
 * ledger-account/dimension-value allocations, when they already exist (e.g.
 * written at create time), still render read-only in the list below.
 */
export default function ExpenseAllocationsCard({
  expenseId,
  status,
  currency,
  amount,
  allocatedAmount,
  unallocatedAmount,
  fullyAllocated
}: {
  expenseId: string;
  /** Add/remove are draft-only, matching `ExpensesService.addAllocation`/`removeAllocation`'s own `assertEditable` lock — listing has no such lock. */
  status: string;
  currency: string;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  fullyAllocated: boolean;
}) {
  const editable = status === 'draft';
  const queryClient = useQueryClient();
  const { data: entities } = useQuery(entitiesQuery);
  const {
    data: allocations,
    isPending,
    isError
  } = useQuery({
    queryKey: ['finance', 'expense', expenseId, 'allocations'],
    queryFn: () => fetchExpenseAllocations({ data: { expenseId } })
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['finance', 'expense', expenseId] });
  };

  const addMutation = useMutation({
    mutationFn: (values: AddAllocationFormValues) =>
      addExpenseAllocation({
        data: {
          expenseId,
          amount: values.amount.trim(),
          economicEntityId:
            values.economicEntityId === NO_ALLOCATION_ENTITY_VALUE ? null : values.economicEntityId,
          channel: values.channel.trim() === '' ? null : values.channel.trim(),
          note: values.note.trim() === '' ? null : values.note.trim()
        }
      }),
    onSuccess: () => {
      toast.success('Allocation added');
      invalidate();
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not add allocation')
  });

  const removeMutation = useMutation({
    mutationFn: (allocationId: string) => removeExpenseAllocation({ data: { allocationId } }),
    onSuccess: () => {
      toast.success('Allocation removed');
      invalidate();
    },
    onError: (error) => toastError(error, 'Could not remove allocation')
  });

  const form = useAppForm({
    defaultValues: {
      amount: '',
      economicEntityId: NO_ALLOCATION_ENTITY_VALUE,
      channel: '',
      note: ''
    } as AddAllocationFormValues,
    validators: { onSubmit: addAllocationSchema },
    onSubmit: async ({ value }) => {
      try {
        await addMutation.mutateAsync(value);
      } catch {
        // Reported through addMutation.onError's toast.
      }
    }
  });

  const entityOptions = [
    { value: NO_ALLOCATION_ENTITY_VALUE, label: 'No entity' },
    ...(entities ?? []).map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  return (
    <div className='flex flex-col gap-3'>
      <div className='flex items-center justify-between'>
        <h3 className='text-sm font-medium'>Allocations</h3>
        <span className='text-muted-foreground text-xs'>
          {formatMoney(allocatedAmount, currency)} of {formatMoney(amount, currency)} allocated
          {!fullyAllocated && (
            <>
              {' '}
              ·{' '}
              <Badge variant='warning' className='align-middle'>
                {formatMoney(unallocatedAmount, currency)} unallocated
              </Badge>
            </>
          )}
        </span>
      </div>

      {isPending ? (
        <p className='text-muted-foreground text-sm'>Loading…</p>
      ) : isError ? (
        <p className='text-destructive text-sm'>Could not load allocations.</p>
      ) : allocations.length === 0 ? (
        <Empty className='py-6'>
          <EmptyHeader>
            <EmptyMedia variant='icon'>
              <Icons.adjustments />
            </EmptyMedia>
            <EmptyTitle>No allocations yet</EmptyTitle>
            <EmptyDescription>
              Where the money is charged, not what was bought — this expense stays valid
              unallocated, or split across entities/channels below.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className='flex flex-col gap-2'>
          {allocations.map((allocation) => {
            const targetLabel =
              allocation.economicEntityName ??
              allocation.acquisitionReferenceCode ??
              allocation.channel ??
              allocation.catalogItemId ??
              allocation.ledgerAccountId ??
              allocation.dimensionValueId ??
              '—';
            return (
              <li
                key={allocation.id}
                className='flex items-center justify-between gap-3 rounded-lg border p-2 px-3'
              >
                <div className='flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm'>
                  <span className='font-medium'>{targetLabel}</span>
                  <span className='tabular-nums'>{formatMoney(allocation.amount, currency)}</span>
                  {allocation.note && (
                    <span className='text-muted-foreground'>{allocation.note}</span>
                  )}
                </div>
                {editable && (
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    aria-label={`Remove allocation: ${targetLabel}`}
                    disabled={removeMutation.isPending}
                    onClick={() => removeMutation.mutate(allocation.id)}
                  >
                    <Icons.trash />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <form
          className='grid grid-cols-1 items-end gap-3 sm:grid-cols-[7rem_1fr_1fr_1fr_auto]'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup className='contents'>
            <form.AppField
              name='amount'
              children={(field) => <field.TextField label='Amount' required placeholder='0.00' />}
            />
            <form.AppField
              name='economicEntityId'
              children={(field) => <field.SelectField label='Entity' options={entityOptions} />}
            />
            <form.AppField
              name='channel'
              children={(field) => <field.TextField label='Channel' placeholder='e.g. eBay' />}
            />
            <form.AppField
              name='note'
              children={(field) => <field.TextField label='Note' placeholder='optional' />}
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
