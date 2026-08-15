import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { useAppForm } from '@/lib/form';
import { toastError } from '@/lib/errors';
import { useDebounce } from '@/hooks/use-debounce';
import { tradingPartnersSearchQuery } from '@/features/finance/api/queries';
import {
  createTradingPartner,
  type TradingPartnerOptionDto
} from '@/server/trading-partner-functions';

/** The picker's own "no counterparty" sentinel — matches every other combobox in this codebase (e.g. `push-draft-invoice-dialog.tsx`'s `counterpartyId` state) rather than `null`, since TanStack Form field values here are plain strings. */
export const NO_TRADING_PARTNER_VALUE = '';

export interface ResolvedPayee {
  id: string;
  displayName: string;
  referenceCode: string;
}

const newTradingPartnerSchema = z.object({
  kind: z.enum(['person', 'organization']),
  displayName: z.string().trim().min(1, 'A name is required'),
  legalName: z.string(),
  email: z.string(),
  role: z.enum(['vendor', 'payee'])
});

type NewTradingPartnerFormValues = z.infer<typeof newTradingPartnerSchema>;

function NewTradingPartnerDialog({
  open,
  onOpenChange,
  economicEntityId,
  onCreated
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  economicEntityId: string | null;
  onCreated: (payee: ResolvedPayee) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (values: NewTradingPartnerFormValues) =>
      createTradingPartner({
        data: {
          kind: values.kind,
          displayName: values.displayName.trim(),
          legalName: values.legalName.trim() === '' ? null : values.legalName.trim(),
          email: values.email.trim() === '' ? null : values.email.trim(),
          role: values.role,
          economicEntityId
        }
      }),
    onSuccess: (result) => {
      toast.success(`${result.referenceCode} created`);
      void queryClient.invalidateQueries({ queryKey: ['finance', 'trading-partners'] });
      onCreated({
        id: result.id,
        displayName: result.displayName,
        referenceCode: result.referenceCode
      });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to create trading partner')
  });

  const form = useAppForm({
    defaultValues: {
      kind: 'organization',
      displayName: '',
      legalName: '',
      email: '',
      role: 'payee'
    } as NewTradingPartnerFormValues,
    validators: { onSubmit: newTradingPartnerSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  React.useEffect(() => {
    if (!open) form.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on close only.
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-[420px]'>
        <DialogHeader>
          <DialogTitle>New trading partner</DialogTitle>
          <DialogDescription>
            The minimum that makes a party useful: who they are, and how to reach them. Everything
            else — tax id, billing address, terms — is filled in later from the counterparty record.
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
              name='kind'
              children={(field) => (
                <field.SelectField
                  label='Kind'
                  options={[
                    { value: 'organization', label: 'Organization' },
                    { value: 'person', label: 'Person' }
                  ]}
                />
              )}
            />
            <form.AppField
              name='displayName'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. Uline' />
              )}
            />
            <form.AppField
              name='legalName'
              children={(field) => (
                <field.TextField label='Legal name (optional)' placeholder='e.g. Uline, Inc.' />
              )}
            />
            <form.AppField
              name='email'
              children={(field) => (
                <field.TextField
                  label='Primary email (optional)'
                  type='email'
                  placeholder='billing@example.com'
                />
              )}
            />
            <form.AppField
              name='role'
              children={(field) => (
                <field.SelectField
                  label='Relationship'
                  options={[
                    { value: 'payee', label: 'Payee — we paid them' },
                    { value: 'vendor', label: 'Vendor — they supply us goods' }
                  ]}
                  description='Payee is the safer default for an expense: it records only "we paid them," not a supply relationship.'
                />
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Create</form.SubmitButton>
            </form.AppForm>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The payee picker (`expense-entry-design.md` section 2, "The picker and
 * inline create").
 *
 * ## Mount contract
 *
 * A standalone CONTROLLED component, not a registered `field.XField` —
 * deliberately, because `@/lib/form.ts`'s `fieldComponents` registry is
 * evaluated eagerly at module scope, and this component itself renders a
 * `useAppForm` form (the inline "+ New trading partner" dialog), which would
 * make `@/lib/form.ts` and this file import each other. Frontend Standards'
 * own escape hatch for exactly this shape — *"for one-off custom fields,
 * drop down to the raw `form.Field` render prop and compose the `Field`
 * primitives directly"* — is what this is. Mount it like:
 *
 * ```tsx
 * <form.Field name='payeeCounterpartyId'>
 *   {(field) => (
 *     <PayeeComboboxField
 *       label='Payee'
 *       value={field.state.value}                 // a plain string; '' means "none"
 *       onChange={field.handleChange}
 *       onBlur={field.handleBlur}
 *       invalid={field.state.meta.isTouched && !field.state.meta.isValid}
 *       errors={field.state.meta.errors}
 *       economicEntityId={resolvedEntityIdOrNull}  // NOT the raw form value —
 *                                                    // resolve UNATTRIBUTED_ENTITY_VALUE to null first
 *       onPayeeSelected={(payee) =>
 *         // optional: mirror the resolved display name into a visible
 *         // payeeName field. The SERVER always snapshots it into
 *         // `expenses.payee_name` regardless — this is UI-only feedback.
 *         form.setFieldValue('payeeName', payee?.displayName ?? form.state.values.payeeName)
 *       }
 *     />
 *   )}
 * </form.Field>
 * ```
 *
 * Selecting "No trading partner — record a name only" calls
 * `onChange(NO_TRADING_PARTNER_VALUE)` (`''`) and `onPayeeSelected?.(null)` —
 * the caller's own free-text payee field stays exactly as typed.
 */
export function PayeeComboboxField({
  label,
  description,
  required,
  invalid = false,
  errors,
  name = 'payeeCounterpartyId',
  value,
  onChange,
  onBlur,
  economicEntityId,
  onPayeeSelected,
  placeholder = 'Select a payee'
}: {
  label: string;
  description?: string;
  required?: boolean;
  invalid?: boolean;
  errors?: Array<{ message?: string } | undefined>;
  /** Element id / `aria-controls` base — cosmetic only, no field registry involved. */
  name?: string;
  /** The counterparty id, or `NO_TRADING_PARTNER_VALUE` (`''`) for none. */
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** The expense's resolved entity, or `null` for unattributed/installation-wide. NOT the raw `UNATTRIBUTED_ENTITY_VALUE` sentinel — resolve it first. */
  economicEntityId: string | null;
  /** Fires on every selection, including "no trading partner" (`null`) and a freshly created partner. */
  onPayeeSelected?: (payee: ResolvedPayee | null) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [createOpen, setCreateOpen] = React.useState(false);
  const debouncedSearch = useDebounce(search, 250);
  const listboxId = `${name}-listbox`;

  const query = useQuery({
    ...tradingPartnersSearchQuery({ search: debouncedSearch, economicEntityId }),
    enabled: open
  });
  const options = query.data ?? [];
  const tradingPartners = options.filter((option) => option.isTradingPartner);
  const otherCounterparties = options.filter((option) => !option.isTradingPartner);

  // The current selection's label may not be in the current search page (a
  // narrow search, or the party was chosen before typing) — resolved from an
  // unfiltered fetch once, cached under its own key.
  const selectedLookup = useQuery({
    ...tradingPartnersSearchQuery({ search: '', economicEntityId }),
    enabled: value !== NO_TRADING_PARTNER_VALUE
  });
  const selected =
    value === NO_TRADING_PARTNER_VALUE
      ? undefined
      : (options.find((option) => option.id === value) ??
        selectedLookup.data?.find((option) => option.id === value));

  function choose(option: TradingPartnerOptionDto | null) {
    onChange(option?.id ?? NO_TRADING_PARTNER_VALUE);
    onPayeeSelected?.(
      option === null
        ? null
        : { id: option.id, displayName: option.displayName, referenceCode: option.referenceCode }
    );
    setOpen(false);
  }

  function renderOption(option: TradingPartnerOptionDto) {
    return (
      <CommandItem
        key={option.id}
        value={option.id}
        keywords={[option.displayName, option.referenceCode]}
        onSelect={() => choose(option)}
      >
        <Icons.check
          className={cn('mr-2 h-4 w-4', value === option.id ? 'opacity-100' : 'opacity-0')}
        />
        <span className='flex-1'>{option.displayName}</span>
        <span className='text-muted-foreground text-xs'>{option.referenceCode}</span>
      </CommandItem>
    );
  }

  return (
    <Field data-invalid={invalid}>
      <FieldLabel htmlFor={name}>
        {label}
        {required && ' *'}
      </FieldLabel>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onBlur?.();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            id={name}
            type='button'
            variant='outline'
            role='combobox'
            aria-controls={listboxId}
            aria-expanded={open}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${name}-error` : undefined}
            className={cn(
              'w-full justify-between font-normal',
              !selected && 'text-muted-foreground'
            )}
          >
            {selected ? selected.displayName : placeholder}
            <Icons.chevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-(--radix-popover-trigger-width) p-0'>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder='Search trading partners…'
              value={search}
              onValueChange={setSearch}
            />
            <CommandList id={listboxId}>
              {query.isLoading && (
                <div className='text-muted-foreground px-3 py-2 text-sm'>Searching…</div>
              )}
              {!query.isLoading && (
                <CommandEmpty>No counterparty matches &quot;{search}&quot;.</CommandEmpty>
              )}
              <CommandGroup>
                <CommandItem value={NO_TRADING_PARTNER_VALUE} onSelect={() => choose(null)}>
                  <Icons.check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === NO_TRADING_PARTNER_VALUE ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  No trading partner — record a name only
                </CommandItem>
              </CommandGroup>
              {tradingPartners.length > 0 && (
                <CommandGroup heading='Trading partners'>
                  {tradingPartners.map(renderOption)}
                </CommandGroup>
              )}
              {otherCounterparties.length > 0 && (
                <CommandGroup heading='Other counterparties'>
                  {otherCounterparties.map(renderOption)}
                </CommandGroup>
              )}
            </CommandList>
            <CommandSeparator />
            <div className='p-1'>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='w-full justify-start'
                onClick={() => {
                  setOpen(false);
                  setCreateOpen(true);
                }}
              >
                <Icons.add className='mr-2 h-4 w-4' />
                New trading partner
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError id={`${name}-error`} errors={errors} />}
      <NewTradingPartnerDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        economicEntityId={economicEntityId}
        onCreated={(payee) => {
          onChange(payee.id);
          onPayeeSelected?.(payee);
        }}
      />
    </Field>
  );
}
