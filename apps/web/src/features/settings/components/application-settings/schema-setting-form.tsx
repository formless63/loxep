import { Fragment, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { FieldGroup } from '@/components/ui/field';
import { errorMessage, toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { updateApplicationSetting, type RegisteredSettingDto } from '@/server/admin-functions';
import { applicationSettingsQuery } from '@/features/settings/api/queries';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import {
  mapSettingJsonSchema,
  parseSettingValidationIssues,
  type SettingFieldWidget,
  type SettingFormShape
} from '@/features/settings/lib/setting-schema-form';

/**
 * The generic schema-driven settings form (loxep-8ja.2,
 * settings-ux-design.md §2). Given a `RegisteredSettingDto`, maps its
 * `jsonSchema` (loxep-8ja.1) to fields per §2.2's table and renders them
 * inside a single `useAppForm` — one Card body, one submit, matching
 * `SettingsService.write`'s one-audit-event-per-save precedent exactly the
 * way `GatusPushCard`/`ProvisioningCard` already do by hand.
 *
 * A shape §2.2 does not cover (a `z.record`, a nested object, …) falls back
 * to the same raw-JSON editing `SettingEditDialog` already offers — the
 * "advanced" escape hatch is built into the renderer itself, not bolted on
 * only by the page that hosts it (loxep-8ja.3).
 */
export function SchemaSettingForm({
  setting,
  onSaved,
  onCancel,
  banner
}: {
  setting: RegisteredSettingDto;
  onSaved?: () => void;
  onCancel?: () => void;
  /**
   * Optional conditional callout above the fields (§2.5's "banner/slot"
   * escape hatch — `infrastructure.caa_policy`'s "not reviewed yet" warning
   * is the reference case). Reads the form's own live values through
   * `form.Subscribe` internally, so the banner stays in sync with an
   * untouched/unsaved edit exactly like `ProvisioningCard`'s hand-written
   * ones do — this is the SAME mechanism, just parameterized so the generic
   * form doesn't have to fork into a class (b) composite just to show one
   * conditional sentence.
   */
  banner?: (values: Record<string, unknown>) => ReactNode;
}) {
  const shape = mapSettingJsonSchema(setting.jsonSchema);

  if (shape.kind === 'unmappable') {
    return <RawJsonSettingForm setting={setting} onSaved={onSaved} onCancel={onCancel} />;
  }

  return (
    <MappedSettingForm
      setting={setting}
      shape={shape}
      onSaved={onSaved}
      onCancel={onCancel}
      banner={banner}
    />
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fieldsOf(shape: SettingFormShape): SettingFieldWidget[] {
  if (shape.kind === 'bare') return [shape.field];
  if (shape.kind === 'object') return shape.fields;
  return [];
}

/** Formats one field's stored value for the non-admin read view — no editing affordance, just prose. */
function formatReadOnlyValue(widget: SettingFieldWidget, raw: unknown): string {
  switch (widget.kind) {
    case 'switch':
      return raw === true ? 'On' : 'Off';
    case 'select': {
      const option = widget.options.find((entry) => entry.value === raw);
      return option?.label ?? (typeof raw === 'string' && raw !== '' ? raw : '—');
    }
    case 'number':
      return typeof raw === 'number' ? String(raw) : '—';
    case 'tags':
      return Array.isArray(raw) && raw.length > 0 ? raw.join(', ') : '—';
    case 'text':
      return typeof raw === 'string' && raw !== '' ? raw : '—';
  }
}

/**
 * Non-admin read view for a class (a) setting — the same field list the
 * generic form maps, rendered as plain label/value pairs rather than inputs.
 * Mirrors `GatusPushCard`'s non-admin `<dl>` branch: a setting's value is
 * non-secret configuration (ADR-0016), so a member reads it; only the write
 * itself is admin-only (`updateApplicationSetting`'s own `requireAdmin`).
 * An unmappable shape falls back to the same read-only pretty-printed JSON
 * an admin's advanced fallback would edit, so nothing here can throw for a
 * class (b)/(c) setting a caller mistakenly renders through this view.
 */
export function SettingReadOnlyView({ setting }: { setting: RegisteredSettingDto }) {
  const shape = mapSettingJsonSchema(setting.jsonSchema);

  if (shape.kind === 'unmappable') {
    return (
      <pre className='bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs'>
        {JSON.stringify(setting.value, null, 2)}
      </pre>
    );
  }

  const fields = fieldsOf(shape);
  const source = isRecord(setting.value) ? setting.value : {};

  return (
    <dl className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
      {fields.map((field) => {
        const raw = shape.kind === 'bare' ? setting.value : source[field.name];
        return (
          <Fragment key={field.name}>
            <dt className='text-muted-foreground'>{field.label}</dt>
            <dd>{formatReadOnlyValue(field, raw)}</dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/** The value shown while editing — `''` stands in for `null` on a nullable text field. */
function initialFieldValue(widget: SettingFieldWidget, raw: unknown): unknown {
  switch (widget.kind) {
    case 'switch':
      return typeof raw === 'boolean' ? raw : false;
    case 'select':
      return typeof raw === 'string' ? raw : (widget.options[0]?.value ?? '');
    case 'number':
      return typeof raw === 'number' ? raw : undefined;
    case 'tags':
      return Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === 'string')
        : [];
    case 'text':
      return typeof raw === 'string' ? raw : '';
  }
}

/** Reverses {@link initialFieldValue} at submit time — empty text on a nullable field submits `null`. */
function composeFieldValue(widget: SettingFieldWidget, value: unknown): unknown {
  switch (widget.kind) {
    case 'switch':
      return Boolean(value);
    case 'select':
      return typeof value === 'string' ? value : '';
    case 'number':
      return value;
    case 'tags':
      return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
    case 'text': {
      const text = typeof value === 'string' ? value.trim() : '';
      if (widget.nullable && text === '') return null;
      return text;
    }
  }
}

type MappedSettingFormShape = Extract<SettingFormShape, { kind: 'object' | 'bare' }>;

function buildDefaultValues(
  shape: MappedSettingFormShape,
  settingValue: unknown
): Record<string, unknown> {
  const source = isRecord(settingValue) ? settingValue : {};
  const values: Record<string, unknown> = {};
  for (const field of fieldsOf(shape)) {
    // The bare shape's synthetic field is named 'value' and reads the
    // setting's own top-level value directly, not a property of it.
    const raw = shape.kind === 'bare' ? settingValue : source[field.name];
    values[field.name] = initialFieldValue(field, raw);
  }
  return values;
}

function composeSettingValue(
  shape: MappedSettingFormShape,
  values: Record<string, unknown>
): unknown {
  if (shape.kind === 'bare') {
    return composeFieldValue(shape.field, values[shape.field.name]);
  }
  const result: Record<string, unknown> = {};
  for (const field of shape.fields) {
    result[field.name] = composeFieldValue(field, values[field.name]);
  }
  return result;
}

function MappedSettingForm({
  setting,
  shape,
  onSaved,
  onCancel,
  banner
}: {
  setting: RegisteredSettingDto;
  shape: MappedSettingFormShape;
  onSaved?: () => void;
  onCancel?: () => void;
  banner?: (values: Record<string, unknown>) => ReactNode;
}) {
  const queryClient = useQueryClient();
  const fields = fieldsOf(shape);

  const mutation = useMutation({
    mutationFn: (values: Record<string, unknown>) =>
      updateApplicationSetting({
        data: { key: setting.key, valueJson: JSON.stringify(composeSettingValue(shape, values)) }
      }),
    onSuccess: () => {
      toast.success(`Saved ${setting.key}`);
      queryClient.invalidateQueries({ queryKey: applicationSettingsQuery.queryKey });
      onSaved?.();
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to save setting')
  });

  const form = useAppForm({
    defaultValues: buildDefaultValues(shape, setting.value),
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value);
      } catch (error) {
        // The server owns validation (§2.1) — its per-path issues become
        // per-field errors here instead of one shared textarea error, the
        // one behavioral change from the raw-JSON dialog this replaces.
        const message = errorMessage(error, 'Failed to save setting');
        const issues = parseSettingValidationIssues(message);
        const knownFieldNames = new Set(fields.map((field) => field.name));
        const matched = issues?.filter((issue) => knownFieldNames.has(issue.path)) ?? [];

        if (matched.length > 0) {
          for (const issue of matched) {
            formApi.setFieldMeta(issue.path, (meta) => ({
              ...meta,
              isTouched: true,
              errorMap: { ...meta?.errorMap, onSubmit: [{ message: issue.message }] }
            }));
          }
        } else {
          // Unparseable or unmatched — attach to the first field so the
          // failure is visible on the form, not only in the toast.
          const firstField = fields[0];
          if (firstField !== undefined) {
            formApi.setFieldMeta(firstField.name, (meta) => ({
              ...meta,
              isTouched: true,
              errorMap: { ...meta?.errorMap, onSubmit: [{ message }] }
            }));
          }
        }
      }
    }
  });

  function renderWidget(widget: SettingFieldWidget) {
    // Keep the concrete type inferred by `useAppForm` while giving JSX an
    // upper-case component binding for the dynamic field renderer.
    const AppField = form.AppField;

    switch (widget.kind) {
      case 'switch':
        return (
          <AppField
            key={widget.name}
            name={widget.name}
            children={(field) => (
              <field.SwitchField label={widget.label} description={widget.description} />
            )}
          />
        );
      case 'select':
        return (
          <AppField
            key={widget.name}
            name={widget.name}
            children={(field) => (
              <field.SelectField
                label={widget.label}
                description={widget.description}
                options={widget.options}
              />
            )}
          />
        );
      case 'number':
        return (
          <AppField
            key={widget.name}
            name={widget.name}
            children={(field) => (
              <field.TextField
                label={widget.label}
                description={widget.description}
                type='number'
                min={widget.min}
                max={widget.max}
              />
            )}
          />
        );
      case 'tags':
        return (
          <AppField
            key={widget.name}
            name={widget.name}
            mode='array'
            children={(field) => (
              <field.TagsField label={widget.label} description={widget.description} />
            )}
          />
        );
      case 'text':
        return (
          <AppField
            key={widget.name}
            name={widget.name}
            children={(field) => (
              <field.TextField
                label={widget.label}
                description={
                  widget.nullable
                    ? [widget.description, 'Leave empty to clear.'].filter(Boolean).join(' — ')
                    : widget.description
                }
              />
            )}
          />
        );
    }
  }

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      {banner && (
        <form.Subscribe selector={(state) => state.values} children={(values) => banner(values)} />
      )}
      {shape.kind === 'object' ? (
        <FieldGroup>{fields.map(renderWidget)}</FieldGroup>
      ) : (
        renderWidget(shape.field)
      )}
      <div className='flex justify-end gap-2'>
        {onCancel && (
          <Button type='button' variant='outline' onClick={onCancel}>
            Cancel
          </Button>
        )}
        <form.AppForm>
          <form.SubmitButton>Save</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}

/**
 * The advanced/raw-JSON fallback (§3's "advanced escape hatch", built into
 * the renderer per this bead's own requirement): any shape §2.2 doesn't map
 * — a `z.record`, a nested object, class (c)'s opaque maps — still gets a
 * working editor instead of a crash. Mirrors `SettingEditDialog`'s own
 * client-shallow-validation stance: "is this JSON at all", server owns the rest.
 */
const rawJsonFormSchema = z.object({
  valueJson: z.string().trim().min(1, 'A JSON value is required')
});
type RawJsonFormValues = z.infer<typeof rawJsonFormSchema>;

function initialJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? '' : serialized;
}

function RawJsonSettingForm({
  setting,
  onSaved,
  onCancel
}: {
  setting: RegisteredSettingDto;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: RawJsonFormValues) =>
      updateApplicationSetting({ data: { key: setting.key, valueJson: values.valueJson } }),
    onSuccess: () => {
      toast.success(`Saved ${setting.key}`);
      queryClient.invalidateQueries({ queryKey: applicationSettingsQuery.queryKey });
      onSaved?.();
    },
    onError: (mutationError) => toastError(mutationError, 'Failed to save setting')
  });

  const form = useAppForm({
    defaultValues: { valueJson: initialJson(setting.value) },
    validators: { onSubmit: rawJsonFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value);
      } catch (error) {
        formApi.setFieldMeta('valueJson', (meta) => ({
          ...meta,
          isTouched: true,
          errorMap: {
            ...meta?.errorMap,
            onSubmit: [{ message: errorMessage(error, 'Failed to save setting') }]
          }
        }));
      }
    }
  });

  return (
    <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
      <Alert>
        <AlertTitle>No generic form for this setting's shape yet</AlertTitle>
        <AlertDescription>
          This setting's value is a map or composite the generic form can't render field-by-field —
          edit it as JSON instead. See this setting's own guide for what a valid value looks like.
        </AlertDescription>
      </Alert>
      <FieldGroup>
        <form.AppField
          name='valueJson'
          children={(field) => (
            <field.TextareaField
              label='Value (JSON)'
              required
              rows={10}
              spellCheck={false}
              className='font-mono text-xs'
              description={`Validated server-side against this setting's registered schema (version ${setting.schemaVersion}).`}
            />
          )}
        />
      </FieldGroup>
      <div className='flex justify-end gap-2'>
        {onCancel && (
          <Button type='button' variant='outline' onClick={onCancel}>
            Cancel
          </Button>
        )}
        <form.AppForm>
          <form.SubmitButton>Save setting</form.SubmitButton>
        </form.AppForm>
      </div>
    </form>
  );
}
