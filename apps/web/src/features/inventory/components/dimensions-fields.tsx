import type * as React from 'react';

/**
 * The four `package_*` enrichment fields (M3, loxep-dgf.3), factored out of
 * `item-enrichment-panel.tsx` as a shared field group —
 * `packages/db/src/schema/inventory.ts`'s
 * `num_nonnulls(length, width, height) in (0, 3)` rule: the three dimensions
 * must be entered together or not at all, enforced client-side by the
 * parent panel's own schema and again by `itemsService.update()`
 * server-side.
 *
 * Named for the PACKED PARCEL, matching the column names: an operator
 * weighing something for a listing weighs the packed box on a shipping
 * scale, which is the number a channel/rate quote needs — not a bare item
 * weight.
 *
 * `form` is intentionally untyped (`AnyReactAppForm`, a loose structural
 * alias): TanStack Form's `withForm` composition — the type-safe way to
 * share a field group across forms — requires the caller's form validator
 * types to match this component's `defaultValues` EXACTLY, which fights the
 * parent panel's own `description` field being present in one and not the
 * other. This is a small, single-parent internal component, so the loss of
 * field-name type-checking here is a deliberate, contained trade rather
 * than one that leaks into the form contract other code depends on.
 */
type DimensionFieldName =
  | 'packageWeightGrams'
  | 'packageLengthMm'
  | 'packageWidthMm'
  | 'packageHeightMm';

export interface AnyReactAppForm {
  AppField: (props: {
    name: DimensionFieldName;
    children: (field: {
      TextField: (props: {
        label: string;
        inputMode?: 'decimal';
        placeholder?: string;
        description?: string;
      }) => React.ReactNode;
    }) => React.ReactNode;
  }) => React.ReactNode | Promise<React.ReactNode>;
}

export function DimensionsFields({ form }: { form: AnyReactAppForm }) {
  return (
    <div className='flex flex-col gap-6'>
      <form.AppField
        name='packageWeightGrams'
        children={(field) => (
          <field.TextField
            label='Package weight (g)'
            inputMode='decimal'
            placeholder='e.g. 850'
            description='The packed parcel, weighed on a shipping scale — not the bare item.'
          />
        )}
      />
      <div className='grid grid-cols-3 gap-3'>
        <form.AppField
          name='packageLengthMm'
          children={(field) => (
            <field.TextField label='Length (mm)' inputMode='decimal' placeholder='e.g. 200' />
          )}
        />
        <form.AppField
          name='packageWidthMm'
          children={(field) => (
            <field.TextField label='Width (mm)' inputMode='decimal' placeholder='e.g. 150' />
          )}
        />
        <form.AppField
          name='packageHeightMm'
          children={(field) => (
            <field.TextField label='Height (mm)' inputMode='decimal' placeholder='e.g. 100' />
          )}
        />
      </div>
    </div>
  );
}
