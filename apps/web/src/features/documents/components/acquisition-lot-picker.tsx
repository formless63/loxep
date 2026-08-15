import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { acquisitionsQuery } from '@/features/inventory/api/queries';
import {
  acquisitionSourceKindOptions,
  acquisitionStatusLabel,
  acquisitionStatusTone
} from '@/features/inventory/constants';
import type { AcquisitionSourceKind } from '@/features/inventory/constants';
import { createAcquisition } from '@/server/inventory-functions';
import type { AcquisitionListItemDto } from '@/server/inventory-functions';

export interface AcquisitionLotTarget {
  id: string;
  referenceCode: string;
  title: string;
}

/**
 * "Open" for the purposes of THIS picker — a lot an operator would still add
 * cost components to. `closed`/`cancelled` are excluded from the list (the
 * server itself refuses `cancelled` too — see `@loxep/inventory`'s
 * `confirmCandidatesAsAcquisition`; this filter is the UI's own "don't even
 * offer it" half of that same rule).
 */
const ATTACHABLE_STATUSES = new Set(['draft', 'open', 'receiving', 'costed']);

const newAcquisitionSchema = z.object({
  title: z.string().trim().min(1, 'A title is required'),
  sourceKind: z.string(),
  vendorName: z.string(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD')
});
type NewAcquisitionFormValues = z.infer<typeof newAcquisitionSchema>;

/**
 * The acquisition-lot picker (loxep-cd3.6, M6) — the specific missing piece
 * Phase 9's M4 flagged as blocking "line items flow through to inventory".
 * Two branches, both resolving to a plain `{ id, referenceCode, title }` the
 * caller then confirms candidates against via `confirmLinesAsAcquisition`:
 *
 *  - "Attach to an open lot" — a searchable list over the SAME
 *    `fetchAcquisitions` read `/inventory/acquisitions` itself uses.
 *  - "Create a new draft" — the `AcquisitionForm` dialog's field shape,
 *    inlined here (the `PayeeComboboxField` inline-create precedent: create
 *    the record, then hand back its identity — the actual cost/candidate
 *    write happens separately, at confirm time, never here).
 *
 * Picking or creating a lot does NOT confirm anything by itself — it only
 * resolves the target the review panel's "Confirm as acquisition" action
 * will use, mirroring the payee combobox's own "selecting is not saving"
 * contract.
 */
export default function AcquisitionLotPickerDialog({
  open,
  onOpenChange,
  onSelected,
  defaultTitle,
  defaultVendorName,
  defaultCurrency
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelected: (target: AcquisitionLotTarget) => void;
  defaultTitle?: string;
  defaultVendorName?: string | null;
  defaultCurrency?: string | null;
}) {
  const [search, setSearch] = React.useState('');
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({ ...acquisitionsQuery({}), enabled: open });
  const attachable = (data ?? []).filter((lot) => ATTACHABLE_STATUSES.has(lot.status));
  const trimmedSearch = search.trim().toLowerCase();
  const filtered =
    trimmedSearch === ''
      ? attachable
      : attachable.filter((lot) =>
          `${lot.title} ${lot.referenceCode} ${lot.vendorName ?? ''}`
            .toLowerCase()
            .includes(trimmedSearch)
        );

  const createMutation = useMutation({
    mutationFn: (values: NewAcquisitionFormValues) =>
      createAcquisition({
        data: {
          title: values.title,
          sourceKind: values.sourceKind as AcquisitionSourceKind,
          currency: values.currency.toUpperCase(),
          vendorName: values.vendorName.trim() === '' ? null : values.vendorName.trim()
        }
      }),
    onSuccess: (result, values) => {
      toast.success(`${result.referenceCode} created`);
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
      onSelected({ id: result.id, referenceCode: result.referenceCode, title: values.title });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not create acquisition')
  });

  const form = useAppForm({
    defaultValues: {
      title: defaultTitle ?? '',
      sourceKind: 'thrift_retail',
      vendorName: defaultVendorName ?? '',
      currency: defaultCurrency ?? 'USD'
    } as NewAcquisitionFormValues,
    validators: { onSubmit: newAcquisitionSchema },
    onSubmit: async ({ value }) => {
      try {
        await createMutation.mutateAsync(value);
      } catch {
        // Reported through createMutation.onError's toast.
      }
    }
  });

  React.useEffect(() => {
    if (open) {
      form.reset();
      setSearch('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only.
  }, [open]);

  function choose(lot: AcquisitionListItemDto) {
    onSelected({ id: lot.id, referenceCode: lot.referenceCode, title: lot.title });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>Choose a lot</DialogTitle>
          <DialogDescription>
            Money that bought goods for resale becomes an acquisition and its cost components —
            never an expense. Attach to an open lot, or start a new one.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue='existing'>
          <TabsList>
            <TabsTrigger value='existing'>Attach to an open lot</TabsTrigger>
            <TabsTrigger value='new'>Create a new draft</TabsTrigger>
          </TabsList>
          <TabsContent value='existing' className='pt-3'>
            <Command shouldFilter={false} className='border'>
              <CommandInput placeholder='Search lots…' value={search} onValueChange={setSearch} />
              <CommandList>
                {isLoading && (
                  <div className='text-muted-foreground px-3 py-2 text-sm'>Loading…</div>
                )}
                {!isLoading && filtered.length === 0 && (
                  <CommandEmpty>No open lot matches — create a new draft instead.</CommandEmpty>
                )}
                <CommandGroup>
                  {filtered.map((lot) => (
                    <CommandItem
                      key={lot.id}
                      value={lot.id}
                      keywords={[lot.title, lot.referenceCode, lot.vendorName ?? '']}
                      onSelect={() => choose(lot)}
                    >
                      <div className='flex min-w-0 flex-1 items-center gap-2'>
                        <span className='truncate font-medium'>{lot.title}</span>
                        <Badge variant='outline'>{lot.referenceCode}</Badge>
                        <Badge variant={acquisitionStatusTone(lot.status)}>
                          {acquisitionStatusLabel(lot.status)}
                        </Badge>
                        {lot.vendorName && (
                          <span className='text-muted-foreground truncate text-xs'>
                            {lot.vendorName}
                          </span>
                        )}
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </TabsContent>
          <TabsContent value='new' className='pt-3'>
            <form
              className='space-y-4'
              onSubmit={(event) => {
                event.preventDefault();
                form.handleSubmit();
              }}
            >
              <FieldGroup>
                <form.AppField
                  name='title'
                  children={(field) => (
                    <field.TextField
                      label='Title'
                      required
                      placeholder='e.g. Route 9 estate sale'
                    />
                  )}
                />
                <form.AppField
                  name='sourceKind'
                  children={(field) => (
                    <field.SelectField
                      label='Source'
                      required
                      options={acquisitionSourceKindOptions}
                    />
                  )}
                />
                <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                  <form.AppField
                    name='vendorName'
                    children={(field) => (
                      <field.TextField label='Vendor' placeholder='e.g. Goodwill' />
                    )}
                  />
                  <form.AppField
                    name='currency'
                    children={(field) => (
                      <field.TextField label='Currency' required placeholder='USD' maxLength={3} />
                    )}
                  />
                </div>
              </FieldGroup>
              <div className='flex justify-end'>
                <form.AppForm>
                  <form.SubmitButton>
                    <Icons.add />
                    Create &amp; attach
                  </form.SubmitButton>
                </form.AppForm>
              </div>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
