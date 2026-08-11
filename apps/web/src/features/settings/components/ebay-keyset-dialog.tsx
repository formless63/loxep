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
import { storeEbayKeyset } from '@/server/ebay-oauth';
import { ebayKeysetStatusQuery } from '@/features/settings/api/queries';

const environmentOptions = [
  { value: 'sandbox', label: 'Sandbox' },
  { value: 'production', label: 'Production' }
];

const keysetFormSchema = z.object({
  environment: z.enum(['sandbox', 'production']),
  appId: z.string().trim().min(1, 'App ID is required'),
  certId: z.string().trim().min(1, 'Cert ID is required'),
  devId: z.string().trim().min(1, 'Dev ID is required'),
  ruName: z.string().trim()
});

type KeysetFormValues = z.infer<typeof keysetFormSchema>;

/**
 * Admin-only eBay application-keyset form (loxep-62y.5). Every field is
 * write-only: the value is sent once to `storeEbayKeyset`
 * (`@/server/ebay-oauth`), which persists it as the encrypted application
 * secret `integration.ebay.keyset` (ADR-0019, purpose `ebay_keyset`) — no
 * read surface ever echoes it back, including this dialog, which always
 * opens blank.
 */
export default function EbayKeysetDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (values: KeysetFormValues) =>
      storeEbayKeyset({
        data: {
          environment: values.environment,
          appId: values.appId,
          certId: values.certId,
          devId: values.devId,
          ruName: values.ruName.trim() === '' ? null : values.ruName.trim()
        }
      }),
    onSuccess: () => {
      toast.success('eBay keyset saved');
      queryClient.invalidateQueries({ queryKey: ebayKeysetStatusQuery.queryKey });
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to save eBay keyset');
    }
  });

  const form = useAppForm({
    defaultValues: {
      environment: 'sandbox',
      appId: '',
      certId: '',
      devId: '',
      ruName: ''
    } as KeysetFormValues,
    validators: {
      onSubmit: keysetFormSchema
    },
    onSubmit: ({ value }) => {
      mutation.mutate(value);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[520px]'>
        <DialogHeader>
          <DialogTitle>Configure eBay keyset</DialogTitle>
          <DialogDescription>
            The eBay developer-portal application keyset — one keyset, shared by every eBay
            connection. Add a redirect URL to the keyset in the eBay developer portal with
            /api/integrations/ebay/callback as its auth-accepted URL, then store the generated
            RuName here to enable the &quot;Connect eBay account&quot; consent flow.
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
              name='environment'
              children={(field) => (
                <field.SelectField label='Environment' required options={environmentOptions} />
              )}
            />
            <form.AppField
              name='appId'
              children={(field) => (
                <field.TextField
                  label='App ID'
                  required
                  autoComplete='off'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='certId'
              children={(field) => (
                <field.TextField
                  label='Cert ID'
                  required
                  type='password'
                  autoComplete='new-password'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='devId'
              children={(field) => (
                <field.TextField
                  label='Dev ID'
                  required
                  type='password'
                  autoComplete='new-password'
                  description='Write-only: stored encrypted, never displayed again.'
                />
              )}
            />
            <form.AppField
              name='ruName'
              children={(field) => (
                <field.TextField
                  label='RuName'
                  autoComplete='off'
                  placeholder='e.g. Your_Name-YourApp-SBX-abc123'
                  description='eBay "Redirect URL name" — required before "Connect eBay account" will work.'
                />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              Save keyset
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
