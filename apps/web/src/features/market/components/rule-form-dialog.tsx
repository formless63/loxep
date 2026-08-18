import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import {
  createOpportunityRule,
  updateOpportunityRule,
  type OpportunityRuleDto
} from '@/server/market-functions';
import { opportunityRulesQuery } from '@/features/market/api/queries';

const ruleFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  enabled: z.boolean(),
  priority: z.number({ error: 'Priority is required' }).int(),
  scoreWeight: z
    .string()
    .trim()
    .regex(/^\d{1,6}(\.\d{1,4})?$/, 'Enter a non-negative number, e.g. 1 or 1.5'),
  eventTypes: z.array(z.string()),
  priceMaxPrice: z.string(),
  priceMinDropAmount: z.string(),
  priceMinDropPercent: z.number().gt(0).lte(100).optional(),
  quantityMinAvailable: z.number().int().nonnegative().optional(),
  quantityMaxAvailable: z.number().int().nonnegative().optional(),
  quantityMinIncrease: z.number().int().positive().optional(),
  listingStateIn: z.array(z.string()),
  listingStateNotIn: z.array(z.string()),
  listingTransitionedTo: z.string(),
  scopeMonitorTargetIds: z.array(z.string())
});

type RuleFormValues = z.infer<typeof ruleFormSchema>;

const decimalPattern = /^\d+(\.\d+)?$/;

/** Builds the nested `conditions` grammar from the flat form values, omitting any group that declares nothing (`opportunityConditionsSchema` requires every present group to declare at least one predicate). */
function buildConditions(values: RuleFormValues): Record<string, unknown> {
  const conditions: Record<string, unknown> = {};
  if (values.eventTypes.length > 0) conditions['eventTypes'] = values.eventTypes;

  const price: Record<string, unknown> = {};
  const maxPrice = values.priceMaxPrice.trim();
  if (maxPrice !== '' && decimalPattern.test(maxPrice)) price['maxPrice'] = maxPrice;
  const minDropAmount = values.priceMinDropAmount.trim();
  if (minDropAmount !== '' && decimalPattern.test(minDropAmount)) {
    price['minDropAmount'] = minDropAmount;
  }
  if (values.priceMinDropPercent !== undefined)
    price['minDropPercent'] = values.priceMinDropPercent;
  if (Object.keys(price).length > 0) conditions['price'] = price;

  const quantity: Record<string, unknown> = {};
  if (values.quantityMinAvailable !== undefined) {
    quantity['minAvailable'] = values.quantityMinAvailable;
  }
  if (values.quantityMaxAvailable !== undefined) {
    quantity['maxAvailable'] = values.quantityMaxAvailable;
  }
  if (values.quantityMinIncrease !== undefined) {
    quantity['minIncrease'] = values.quantityMinIncrease;
  }
  if (Object.keys(quantity).length > 0) conditions['quantity'] = quantity;

  const listing: Record<string, unknown> = {};
  if (values.listingStateIn.length > 0) listing['stateIn'] = values.listingStateIn;
  if (values.listingStateNotIn.length > 0) listing['stateNotIn'] = values.listingStateNotIn;
  const transitionedTo = values.listingTransitionedTo.trim();
  if (transitionedTo !== '') listing['transitionedTo'] = transitionedTo;
  if (Object.keys(listing).length > 0) conditions['listing'] = listing;

  if (values.scopeMonitorTargetIds.length > 0) {
    conditions['scope'] = { monitorTargetIds: values.scopeMonitorTargetIds };
  }

  return conditions;
}

/** The inverse of {@link buildConditions} — populates the flat form from a stored rule's nested conditions, for editing. */
function flattenConditions(
  conditions: OpportunityRuleDto['conditions']
): Omit<RuleFormValues, 'name' | 'enabled' | 'priority' | 'scoreWeight'> {
  const price = (conditions['price'] ?? {}) as Record<string, unknown>;
  const quantity = (conditions['quantity'] ?? {}) as Record<string, unknown>;
  const listing = (conditions['listing'] ?? {}) as Record<string, unknown>;
  const scope = (conditions['scope'] ?? {}) as Record<string, unknown>;
  return {
    eventTypes: Array.isArray(conditions['eventTypes'])
      ? (conditions['eventTypes'] as string[])
      : [],
    priceMaxPrice: typeof price['maxPrice'] === 'string' ? price['maxPrice'] : '',
    priceMinDropAmount: typeof price['minDropAmount'] === 'string' ? price['minDropAmount'] : '',
    priceMinDropPercent:
      typeof price['minDropPercent'] === 'number' ? price['minDropPercent'] : undefined,
    quantityMinAvailable:
      typeof quantity['minAvailable'] === 'number' ? quantity['minAvailable'] : undefined,
    quantityMaxAvailable:
      typeof quantity['maxAvailable'] === 'number' ? quantity['maxAvailable'] : undefined,
    quantityMinIncrease:
      typeof quantity['minIncrease'] === 'number' ? quantity['minIncrease'] : undefined,
    listingStateIn: Array.isArray(listing['stateIn']) ? (listing['stateIn'] as string[]) : [],
    listingStateNotIn: Array.isArray(listing['stateNotIn'])
      ? (listing['stateNotIn'] as string[])
      : [],
    listingTransitionedTo:
      typeof listing['transitionedTo'] === 'string' ? listing['transitionedTo'] : '',
    scopeMonitorTargetIds: Array.isArray(scope['monitorTargetIds'])
      ? (scope['monitorTargetIds'] as string[])
      : []
  };
}

/**
 * Create/edit dialog for opportunity rules (loxep-7fs, A16) — structurally
 * identical to `MonitorFormDialog`: one `ResponsiveDialog`, one `useAppForm`,
 * one `SubmitButton`-equivalent pair. The condition grammar
 * (`opportunityConditionsSchema`, `packages/market/src/opportunities.ts`) is
 * five independent optional groups rather than a type-discriminated shape,
 * so every group renders always (no `form.Subscribe` branching needed) and
 * {@link buildConditions} drops any group left empty at submit.
 */
export default function RuleFormDialog({
  open,
  onOpenChange,
  rule
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rule: OpportunityRuleDto | null;
}) {
  const queryClient = useQueryClient();
  const isEdit = rule !== null;

  const mutation = useMutation({
    mutationFn: (values: RuleFormValues) => {
      const conditions = buildConditions(values);
      if (isEdit) {
        return updateOpportunityRule({
          data: {
            id: rule.id,
            name: values.name,
            enabled: values.enabled,
            priority: values.priority,
            scoreWeight: values.scoreWeight,
            conditions
          }
        });
      }
      return createOpportunityRule({
        data: {
          name: values.name,
          enabled: values.enabled,
          priority: values.priority,
          scoreWeight: values.scoreWeight,
          conditions
        }
      });
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Rule updated' : 'Rule created');
      void queryClient.invalidateQueries({ queryKey: opportunityRulesQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save rule');
    }
  });

  const flattened = rule ? flattenConditions(rule.conditions) : null;

  const form = useAppForm({
    defaultValues: {
      name: rule?.name ?? '',
      enabled: rule?.enabled ?? true,
      priority: rule?.priority ?? 0,
      scoreWeight: rule?.scoreWeight ?? '1.0000',
      eventTypes: flattened?.eventTypes ?? [],
      priceMaxPrice: flattened?.priceMaxPrice ?? '',
      priceMinDropAmount: flattened?.priceMinDropAmount ?? '',
      priceMinDropPercent: flattened?.priceMinDropPercent,
      quantityMinAvailable: flattened?.quantityMinAvailable,
      quantityMaxAvailable: flattened?.quantityMaxAvailable,
      quantityMinIncrease: flattened?.quantityMinIncrease,
      listingStateIn: flattened?.listingStateIn ?? [],
      listingStateNotIn: flattened?.listingStateNotIn ?? [],
      listingTransitionedTo: flattened?.listingTransitionedTo ?? '',
      scopeMonitorTargetIds: flattened?.scopeMonitorTargetIds ?? []
    } as RuleFormValues,
    validators: { onSubmit: ruleFormSchema },
    onSubmit: ({ value }) => mutation.mutate(value)
  });

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[560px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{isEdit ? 'Edit rule' : 'New rule'}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            All declared predicates are ANDed. At least one group below must declare a predicate.
            The first (lowest-priority-number) matching enabled rule stamps and scores the event.
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
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. Deep price drops' />
              )}
            />
            <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
              <form.AppField
                name='priority'
                children={(field) => (
                  <field.TextField
                    label='Priority'
                    required
                    type='number'
                    description='Smaller runs first; the first match wins.'
                  />
                )}
              />
              <form.AppField
                name='scoreWeight'
                children={(field) => (
                  <field.TextField
                    label='Score weight'
                    required
                    description='Multiplier in the scoring formula.'
                  />
                )}
              />
            </div>
            <form.AppField
              name='enabled'
              children={(field) => (
                <field.SwitchField
                  label='Enabled'
                  description='Disabled rules are never evaluated against new events.'
                />
              )}
            />

            <div className='space-y-2 border-t pt-4'>
              <p className='text-sm font-medium'>Event types</p>
              <form.AppField
                name='eventTypes'
                mode='array'
                children={(field) => (
                  <field.TagsField
                    label='Event types'
                    placeholder='e.g. price_dropped'
                    description='price_changed, price_dropped, restocked, sold_out, quantity_changed, listing_ended, new_listing.'
                  />
                )}
              />
            </div>

            <div className='space-y-4 border-t pt-4'>
              <p className='text-sm font-medium'>Price</p>
              <div className='grid grid-cols-1 gap-6 md:grid-cols-3'>
                <form.AppField
                  name='priceMaxPrice'
                  children={(field) => (
                    <field.TextField label='Max price' placeholder='e.g. 50.00' />
                  )}
                />
                <form.AppField
                  name='priceMinDropAmount'
                  children={(field) => (
                    <field.TextField label='Min drop amount' placeholder='e.g. 10.00' />
                  )}
                />
                <form.AppField
                  name='priceMinDropPercent'
                  children={(field) => (
                    <field.TextField
                      label='Min drop percent'
                      type='number'
                      min={0}
                      max={100}
                      placeholder='e.g. 20'
                    />
                  )}
                />
              </div>
            </div>

            <div className='space-y-4 border-t pt-4'>
              <p className='text-sm font-medium'>Quantity</p>
              <div className='grid grid-cols-1 gap-6 md:grid-cols-3'>
                <form.AppField
                  name='quantityMinAvailable'
                  children={(field) => (
                    <field.TextField label='Min available' type='number' min={0} />
                  )}
                />
                <form.AppField
                  name='quantityMaxAvailable'
                  children={(field) => (
                    <field.TextField label='Max available' type='number' min={0} />
                  )}
                />
                <form.AppField
                  name='quantityMinIncrease'
                  children={(field) => (
                    <field.TextField label='Min increase' type='number' min={1} />
                  )}
                />
              </div>
            </div>

            <div className='space-y-4 border-t pt-4'>
              <p className='text-sm font-medium'>Listing</p>
              <form.AppField
                name='listingStateIn'
                mode='array'
                children={(field) => <field.TagsField label='State in' placeholder='e.g. active' />}
              />
              <form.AppField
                name='listingStateNotIn'
                mode='array'
                children={(field) => (
                  <field.TagsField label='State not in' placeholder='e.g. ended' />
                )}
              />
              <form.AppField
                name='listingTransitionedTo'
                children={(field) => (
                  <field.TextField
                    label='Transitioned to'
                    placeholder='e.g. ended'
                    description='Matches only the instant the listing state changed to this value.'
                  />
                )}
              />
            </div>

            <div className='space-y-2 border-t pt-4'>
              <p className='text-sm font-medium'>Scope</p>
              <form.AppField
                name='scopeMonitorTargetIds'
                mode='array'
                children={(field) => (
                  <field.TagsField
                    label='Monitor target ids'
                    placeholder='Paste a monitor id'
                    description='Restricts this rule to events from specific monitors. Leave empty to apply to every monitor.'
                  />
                )}
              />
            </div>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              {isEdit ? 'Save changes' : 'Create rule'}
            </Button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
