import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { expenseCategoriesQuery } from '@/features/finance/api/queries';
import { SUGGESTED_EXPENSE_CATEGORIES } from '@/features/finance/constants';

/**
 * The creatable category combobox (expense entry v2, loxep-zk5 —
 * `expense-entry-design.md`'s recorded answer on categories). `category`
 * stays an OPEN set — no CoA foreign key, no `CHECK` (`EXPENSE_CATEGORIES`'s
 * own doc, `packages/db/src/schema/expenses.ts`) — so this combobox always
 * accepts free text; it never blocks on "not in the list."
 *
 * Options = distinct categories already used in THIS installation
 * (`fetchExpenseCategories`/`expenseCategoriesQuery`) merged with the
 * starter vocabulary (`SUGGESTED_EXPENSE_CATEGORIES`), deduped, sorted.
 * Typing a value that matches neither shows the calm hint the bead records
 * as the deliberate answer to "tie back to chart-of-accounts?": there is no
 * categories table and no CoA FK — the posting-rules engine (`/finance/books`)
 * IS the designed category -> account connection, and a second mapping here
 * would be a parallel truth. No dedicated posting-rules page exists in
 * `apps/web` yet (PROVISIONAL — see this pass's own report), so the hint
 * links to the closest real surface, the books list.
 *
 * Standalone, not a registered `field.XField` — mirrors
 * `payee-combobox-field.tsx`'s own mount contract exactly (drop down to the
 * raw `form.Field` render prop, per Frontend Standards' documented escape
 * hatch), for consistency with this file's own precedent rather than any
 * technical requirement of this component.
 */
export function CategoryComboboxField({
  label,
  description,
  required,
  invalid = false,
  errors,
  name = 'category',
  value,
  onChange,
  onBlur,
  placeholder = 'Select or type a category'
}: {
  label: string;
  description?: string;
  required?: boolean;
  invalid?: boolean;
  errors?: Array<{ message?: string } | undefined>;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const listboxId = `${name}-listbox`;

  const query = useQuery({ ...expenseCategoriesQuery, enabled: open });
  const options = React.useMemo(() => {
    const merged = new Set<string>([...(query.data ?? []), ...SUGGESTED_EXPENSE_CATEGORIES]);
    return [...merged].toSorted((a, b) => a.localeCompare(b));
  }, [query.data]);

  const trimmedSearch = search.trim();
  const filtered =
    trimmedSearch === ''
      ? options
      : options.filter((option) => option.toLowerCase().includes(trimmedSearch.toLowerCase()));
  const isNewCategory =
    trimmedSearch !== '' &&
    !options.some((option) => option.toLowerCase() === trimmedSearch.toLowerCase());

  function choose(next: string) {
    onChange(next);
    setSearch('');
    setOpen(false);
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
          if (!next) {
            onBlur?.();
            setSearch('');
          }
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
              value === '' && 'text-muted-foreground'
            )}
          >
            {value === '' ? placeholder : value}
            <Icons.chevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-(--radix-popover-trigger-width) p-0'>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder='Search or type a new category…'
              value={search}
              onValueChange={setSearch}
            />
            <CommandList id={listboxId}>
              {query.isLoading && (
                <div className='text-muted-foreground px-3 py-2 text-sm'>Loading…</div>
              )}
              {!query.isLoading && filtered.length === 0 && !isNewCategory && (
                <CommandEmpty>No categories yet.</CommandEmpty>
              )}
              {filtered.length > 0 && (
                <CommandGroup heading='Categories'>
                  {filtered.map((option) => (
                    <CommandItem key={option} value={option} onSelect={() => choose(option)}>
                      <Icons.check
                        className={cn(
                          'mr-2 h-4 w-4',
                          value === option ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      {option}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {isNewCategory && (
                <CommandGroup heading='New'>
                  <CommandItem
                    value={`__create__${trimmedSearch}`}
                    onSelect={() => choose(trimmedSearch)}
                  >
                    <Icons.add className='mr-2 h-4 w-4' />
                    Use &quot;{trimmedSearch}&quot;
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
            {isNewCategory && (
              <div className='text-muted-foreground border-t p-2 text-xs'>
                New category — posting rules map categories to accounts.{' '}
                <Link to='/finance/books' className='text-primary hover:underline'>
                  Manage posting rules
                </Link>
              </div>
            )}
          </Command>
        </PopoverContent>
      </Popover>
      {description && <FieldDescription>{description}</FieldDescription>}
      {invalid && <FieldError id={`${name}-error`} errors={errors} />}
    </Field>
  );
}
