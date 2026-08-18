import * as React from 'react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { createLocation, setLocationParent } from '@/server/inventory-functions';
import { inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { locationKindOptions } from '@/features/inventory/constants';
import type { InventoryLocationDto } from '@/server/inventory-functions';

const NO_PARENT_VALUE = '__root__';

const addLocationSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, 'A code is required')
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Letters, digits, dot, dash, underscore only')
    .refine((value) => !value.includes('/'), "May not contain '/'"),
  name: z.string().trim().min(1, 'A name is required'),
  kind: z.string(),
  parentLocationId: z.string(),
  isDefault: z.boolean()
});

type AddLocationFormValues = z.infer<typeof addLocationSchema>;

/**
 * A6 (loxep-wx3) — `LocationsService.create` had zero callers and
 * `/inventory/locations` was read-only, which meant a fresh install could
 * never create the first location: the `locationId` field on intake and the
 * location filter on `/inventory/stock` stayed permanently empty. Mounts
 * `createLocation` (`@/server/inventory-functions.ts`) directly.
 */
export function AddLocationDialog({
  open,
  onOpenChange,
  locations
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: InventoryLocationDto[];
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: AddLocationFormValues) =>
      createLocation({
        data: {
          code: values.code.trim(),
          name: values.name.trim(),
          kind: values.kind as never,
          parentLocationId:
            values.parentLocationId === NO_PARENT_VALUE ? null : values.parentLocationId,
          isDefault: values.isDefault
        }
      }),
    onSuccess: () => {
      toast.success('Location created');
      void queryClient.invalidateQueries({ queryKey: inventoryLocationsQuery.queryKey });
      onOpenChange(false);
      form.reset();
    },
    onError: (error) => toastError(error, 'Could not create location')
  });

  const form = useAppForm({
    defaultValues: {
      code: '',
      name: '',
      kind: 'site',
      parentLocationId: NO_PARENT_VALUE,
      isDefault: false
    } as AddLocationFormValues,
    validators: { onSubmit: addLocationSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  const parentOptions = [
    { value: NO_PARENT_VALUE, label: 'No parent (top level)' },
    ...locations.map((location) => ({ value: location.id, label: location.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[440px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Add location</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A site, room, shelf, or bin — as fine-grained as the operation needs, and no finer.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form
          className='space-y-6'
          onSubmit={(event) => {
            event.preventDefault();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
              <form.AppField
                name='code'
                children={(field) => (
                  <field.TextField label='Code' required placeholder='e.g. shelf-a1' />
                )}
              />
              <form.AppField
                name='kind'
                children={(field) => (
                  <field.SelectField label='Kind' required options={locationKindOptions} />
                )}
              />
            </div>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField label='Name' required placeholder='e.g. Shelf A1' />
              )}
            />
            <form.AppField
              name='parentLocationId'
              children={(field) => <field.SelectField label='Parent' options={parentOptions} />}
            />
            <form.AppField
              name='isDefault'
              children={(field) => (
                <field.SwitchField
                  label='Default location'
                  description='Pre-selected on intake when no location is picked.'
                />
              )}
            />
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
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/**
 * A6 — "Move to parent" row action. `LocationsService.setParent` rewrites
 * `path`/`depth` for the whole re-parented subtree; refusals (a cycle, an
 * unknown parent) surface through the mutation's own error toast.
 */
export function MoveLocationDialog({
  open,
  onOpenChange,
  location,
  locations
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location: InventoryLocationDto | null;
  locations: InventoryLocationDto[];
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (parentLocationId: string) =>
      setLocationParent({
        data: {
          locationId: location?.id as string,
          parentLocationId: parentLocationId === NO_PARENT_VALUE ? null : parentLocationId
        }
      }),
    onSuccess: () => {
      toast.success('Location moved');
      void queryClient.invalidateQueries({ queryKey: inventoryLocationsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Could not move location')
  });

  const [parentLocationId, setParentLocationId] = React.useState(NO_PARENT_VALUE);

  React.useEffect(() => {
    if (open && location) setParentLocationId(location.parentLocationId ?? NO_PARENT_VALUE);
  }, [open, location]);

  if (location === null) return null;

  const parentOptions = [
    { value: NO_PARENT_VALUE, label: 'No parent (top level)' },
    ...locations
      .filter((candidate) => candidate.id !== location.id)
      .map((candidate) => ({ value: candidate.id, label: candidate.name }))
  ];

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[420px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Move {location.name}</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Re-parents this location and rewrites every descendant's path — a cycle (moving a
            location under its own descendant) is refused.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        {/*
          Plain `Select` + submit rather than `useAppForm` — a single field
          with no validation beyond "pick one", matching `LinkPayeeDialog`'s
          own precedent for a one-field selection dialog
          (`@/features/finance/components/expense-detail.tsx`).
        */}
        <div className='space-y-6'>
          <FieldGroup>
            <Select value={parentLocationId} onValueChange={setParentLocationId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {parentOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type='button'
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(parentLocationId)}
            >
              {mutation.isPending && <Icons.spinner className='animate-spin' />}
              Move
            </Button>
          </div>
        </div>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
