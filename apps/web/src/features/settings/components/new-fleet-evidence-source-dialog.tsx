import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import { CopyableValue } from '@/features/settings/components/setup-guidance';
import { submitFormEvent } from '@/features/settings/lib/dialog-form';
import { fleetEvidenceSourcesQuery } from '@/features/settings/api/queries';
import { createFleetEvidenceSource } from '@/server/admin-functions';

const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: 'gatus', label: 'Gatus (custom alerting provider)' },
  { value: 'beszel', label: 'Beszel (Shoutrrr generic webhook)' },
  { value: 'databasus', label: 'Databasus (backup success/failure webhook)' },
  { value: 'generic', label: 'Generic (any sender using the Loxep evidence JSON contract)' }
];

const newSourceFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  provider: z.enum(['gatus', 'beszel', 'databasus', 'generic'])
});

/**
 * Configure one inbound fleet-evidence source (Phase 8 milestone 7,
 * loxep-ovj.7): mints a per-connection ingest token and shows it — and the
 * webhook URL to paste into the sender's own configuration — exactly once,
 * via `RevealOnceDialog`'s ADR-0022 pattern (`MintTokenDialog`'s shape,
 * reused here for a token this dialog mints itself in one round trip rather
 * than a nested one-time reveal component).
 */
export default function NewFleetEvidenceSourceDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [revealed, setRevealed] = React.useState<{
    connectionId: string;
    token: string;
    url: string;
  } | null>(null);

  const mutation = useMutation({
    mutationFn: (values: z.infer<typeof newSourceFormSchema>) =>
      createFleetEvidenceSource({ data: values }),
    onSuccess: async (result) => {
      const origin = typeof window === 'undefined' ? '' : window.location.origin;
      setRevealed({
        connectionId: result.connectionId,
        token: result.token,
        url: `${origin}/api/v1/hooks/fleet/${result.connectionId}`
      });
      await queryClient.invalidateQueries({ queryKey: fleetEvidenceSourcesQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to create evidence source')
  });

  const form = useAppForm({
    defaultValues: { name: '', provider: 'generic' } as z.infer<typeof newSourceFormSchema>,
    validators: { onSubmit: newSourceFormSchema },
    onSubmit: async ({ value }) => {
      try {
        await mutation.mutateAsync(value);
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  function close(next: boolean) {
    if (!next) {
      setRevealed(null);
      form.reset();
    }
    setOpen(next);
  }

  if (revealed !== null) {
    return (
      <Dialog open={open} onOpenChange={close}>
        <DialogContent
          className='sm:max-w-[560px]'
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Evidence source configured</DialogTitle>
            <DialogDescription>
              Paste the URL and the token into the sender&apos;s own configuration now — the token
              is shown exactly once.
            </DialogDescription>
          </DialogHeader>
          <Alert variant='warning'>
            <Icons.warning />
            <AlertTitle>You will not see this token again</AlertTitle>
            <AlertDescription>
              Loxep stores only an encrypted copy with no read-back path — a lost token means
              creating a new evidence source, not recovering this one.
            </AlertDescription>
          </Alert>
          <CopyableValue label='Webhook URL' value={revealed.url} copyLabel='Copy URL' />
          <CopyableValue label='Bearer token' value={revealed.token} copyLabel='Copy token' />
          <DialogFooter>
            <Button onClick={() => close(false)}>I&apos;ve saved these values</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogTrigger asChild>
        <Button size='sm'>New evidence source</Button>
      </DialogTrigger>
      <DialogContent className='sm:max-w-[480px]'>
        <DialogHeader>
          <DialogTitle>New inbound evidence source</DialogTitle>
          <DialogDescription>
            Creates a dedicated, evidence-only connection and mints a bearer token for it. Recording
            evidence is not delivering an alert — the sending tool must still alert its own operator
            directly (ntfy or otherwise); Loxep only rolls the evidence into integration health.
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-6' onSubmit={submitFormEvent(form.handleSubmit)}>
          <FieldGroup>
            <form.AppField
              name='name'
              children={(field) => (
                <field.TextField
                  label='Name'
                  required
                  placeholder='e.g. nightly Databasus backup'
                />
              )}
            />
            <form.AppField
              name='provider'
              children={(field) => (
                <field.SelectField label='Sender' required options={PROVIDER_OPTIONS} />
              )}
            />
          </FieldGroup>
          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={() => close(false)}>
              Cancel
            </Button>
            <form.AppForm>
              <form.SubmitButton>Create</form.SubmitButton>
            </form.AppForm>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
