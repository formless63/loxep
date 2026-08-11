import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { useAppForm } from '@/lib/form';
import { registerStorageBackend } from '@/server/admin-functions';
import { storageBackendsQuery } from '@/features/settings/api/queries';
import { STORAGE_DRIVER_LABELS } from '@/features/settings/constants';

const storageFormSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required'),
    driver: z.enum(['local', 's3']),
    makeDefault: z.boolean(),
    rootDir: z.string(),
    endpoint: z.string(),
    region: z.string(),
    bucket: z.string(),
    forcePathStyle: z.boolean(),
    accessKeyId: z.string(),
    secretAccessKey: z.string()
  })
  .superRefine((values, ctx) => {
    if (values.driver === 'local') {
      if (!values.rootDir.trim().startsWith('/')) {
        ctx.addIssue({
          code: 'custom',
          path: ['rootDir'],
          message: 'Root directory must be an absolute path'
        });
      }
      return;
    }
    if (!z.url().safeParse(values.endpoint).success) {
      ctx.addIssue({ code: 'custom', path: ['endpoint'], message: 'Endpoint must be a URL' });
    }
    if (values.region.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['region'], message: 'Region is required' });
    }
    if (values.bucket.trim() === '') {
      ctx.addIssue({ code: 'custom', path: ['bucket'], message: 'Bucket is required' });
    }
    if (values.accessKeyId === '') {
      ctx.addIssue({ code: 'custom', path: ['accessKeyId'], message: 'Access key is required' });
    }
    if (values.secretAccessKey === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['secretAccessKey'],
        message: 'Secret key is required'
      });
    }
  });

type StorageFormValues = z.infer<typeof storageFormSchema>;

const driverOptions = (Object.keys(STORAGE_DRIVER_LABELS) as ('local' | 's3')[]).map((value) => ({
  value,
  label: STORAGE_DRIVER_LABELS[value]
}));

/**
 * Register-backend dialog. S3 access key/secret fields are write-only: they
 * are sent once, stored through the encrypted secrets service, and never
 * echoed back by any read surface.
 */
export default function StorageBackendDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: StorageFormValues) =>
      registerStorageBackend({
        data:
          values.driver === 'local'
            ? {
                driver: 'local',
                name: values.name,
                makeDefault: values.makeDefault,
                rootDir: values.rootDir.trim()
              }
            : {
                driver: 's3',
                name: values.name,
                makeDefault: values.makeDefault,
                endpoint: values.endpoint.trim(),
                region: values.region.trim(),
                bucket: values.bucket.trim(),
                forcePathStyle: values.forcePathStyle,
                accessKeyId: values.accessKeyId,
                secretAccessKey: values.secretAccessKey
              }
      }),
    onSuccess: () => {
      toast.success('Storage backend registered');
      queryClient.invalidateQueries({ queryKey: storageBackendsQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to register backend');
    }
  });

  const form = useAppForm({
    defaultValues: {
      name: '',
      driver: 'local',
      makeDefault: false,
      rootDir: '',
      endpoint: '',
      region: '',
      bucket: '',
      forcePathStyle: true,
      accessKeyId: '',
      secretAccessKey: ''
    } as StorageFormValues,
    validators: {
      onSubmit: storageFormSchema
    },
    onSubmit: ({ value }) => {
      mutation.mutate(value);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>Register storage backend</DialogTitle>
          <DialogDescription>
            Storage destinations are configured resources behind one driver abstraction — local
            filesystem or any S3-compatible endpoint (ADR-0012, ADR-0014).
          </DialogDescription>
        </DialogHeader>
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
                <field.TextField label='Name' required placeholder='e.g. primary-media' />
              )}
            />
            <form.AppField
              name='driver'
              children={(field) => (
                <field.SelectField label='Driver' required options={driverOptions} />
              )}
            />
            <form.Subscribe selector={(state) => state.values.driver}>
              {(driver) =>
                driver === 'local' ? (
                  <form.AppField
                    name='rootDir'
                    children={(field) => (
                      <field.TextField
                        label='Root directory'
                        required
                        placeholder='/var/lib/loxep/media'
                        description='Absolute path on the Loxep host.'
                      />
                    )}
                  />
                ) : (
                  <>
                    <form.AppField
                      name='endpoint'
                      children={(field) => (
                        <field.TextField
                          label='Endpoint'
                          required
                          placeholder='https://s3.example.com'
                        />
                      )}
                    />
                    <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
                      <form.AppField
                        name='region'
                        children={(field) => (
                          <field.TextField label='Region' required placeholder='us-east-1' />
                        )}
                      />
                      <form.AppField
                        name='bucket'
                        children={(field) => (
                          <field.TextField label='Bucket' required placeholder='loxep-media' />
                        )}
                      />
                    </div>
                    <form.AppField
                      name='forcePathStyle'
                      children={(field) => (
                        <field.SwitchField
                          label='Force path-style addressing'
                          description='Required by most self-hosted S3-compatible stores.'
                        />
                      )}
                    />
                    <form.AppField
                      name='accessKeyId'
                      children={(field) => (
                        <field.TextField
                          label='Access key ID'
                          required
                          autoComplete='off'
                          description='Write-only: stored encrypted, never displayed again.'
                        />
                      )}
                    />
                    <form.AppField
                      name='secretAccessKey'
                      children={(field) => (
                        <field.TextField
                          label='Secret access key'
                          required
                          type='password'
                          autoComplete='new-password'
                          description='Write-only: stored encrypted, never displayed again.'
                        />
                      )}
                    />
                  </>
                )
              }
            </form.Subscribe>
            <form.AppField
              name='makeDefault'
              children={(field) => (
                <field.SwitchField
                  label='Make default backend'
                  description='New uploads go to the default backend.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              Register backend
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
