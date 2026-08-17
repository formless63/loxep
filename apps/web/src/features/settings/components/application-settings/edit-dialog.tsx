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
import { toastError, errorMessage } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { updateApplicationSetting, type RegisteredSettingDto } from '@/server/admin-functions';
import { applicationSettingsQuery } from '@/features/settings/api/queries';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';

/**
 * Client-side validation is deliberately shallow: only "is this JSON at all".
 * The setting's real schema is a Zod object in `@loxep/domain`'s registry,
 * which the browser has no access to (and must not, since the registry is
 * what makes an unknown key unwritable), so the raw text goes to the server
 * function and the server's `SettingValidationError` message — "afterDays:
 * Number must be greater than or equal to 1" — is what the operator reads.
 */
const settingFormSchema = z.object({
  valueJson: z.string().trim().min(1, 'A JSON value is required')
});

type SettingFormValues = z.infer<typeof settingFormSchema>;

/** Pretty-printed so an object setting opens as an editable block, not one line. */
function initialJson(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized === undefined ? '' : serialized;
}

export default function SettingEditDialog({
  open,
  onOpenChange,
  setting
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setting: RegisteredSettingDto;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: SettingFormValues) =>
      updateApplicationSetting({ data: { key: setting.key, valueJson: values.valueJson } }),
    onSuccess: () => {
      toast.success(`Saved ${setting.key}`);
      queryClient.invalidateQueries({ queryKey: applicationSettingsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => toastError(error, 'Failed to save setting')
  });

  const form = useAppForm({
    defaultValues: { valueJson: initialJson(setting.value) },
    validators: { onSubmit: settingFormSchema },
    onSubmit: async ({ value, formApi }) => {
      try {
        await mutation.mutateAsync(value);
      } catch (error) {
        // The server owns validation, so its message IS the field error.
        // `{ message }` objects, not strings — shadcn's <FieldError> only
        // renders object entries (the shape Zod issues arrive in).
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
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className='sm:max-w-[560px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className='font-mono text-sm break-all'>
            {setting.key}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>{setting.description}</ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
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
                  description={`Validated server-side against this setting's registered schema (version ${setting.schemaVersion}). Workers re-read application settings on a short cache, so a saved change is picked up within seconds — no restart.`}
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Save setting</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
