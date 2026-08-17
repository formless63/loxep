import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import {
  counterpartyBillingSearchQuery,
  draftInvoicePushStatusQuery,
  invoiceNinjaConnectionsQuery
} from '@/features/finance/api/queries';
import { listUnbilledWorkForBilling, pushDraftInvoice } from '@/server/finance-billing-functions';

const DECIMAL_STRING = /^\d+(\.\d{1,6})?$/;

interface DraftLine {
  description: string;
  quantity: string;
  unitCost: string;
}

function emptyLine(): DraftLine {
  return { description: '', quantity: '1', unitCost: '' };
}

function linesAreValid(lines: DraftLine[]): boolean {
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.description.trim() !== '' &&
        DECIMAL_STRING.test(line.quantity) &&
        DECIMAL_STRING.test(line.unitCost)
    )
  );
}

/**
 * On-demand Invoice Ninja draft-invoice push (loxep-v5r.5).
 *
 * Line items are entered BY HAND by default, with an optional "Load unbilled
 * work" action that appends `@loxep/work`'s unbilled time entries/material
 * uses (once a counterparty is chosen) as editable rows — appended, not
 * auto-submitted, because `alwaysUnbilledResolver` (the honest default
 * `@loxep/work` ships, since `invoice_line_sources` does not exist) cannot
 * tell whether a row is already covered by an open draft push; the
 * idempotency banner above catches that case separately. A time entry with
 * an unresolved bill rate loads with an empty unit cost and must be filled
 * in before submitting.
 *
 * The idempotency check (has this counterparty/project already got an open
 * draft push?) is real and shown below the counterparty/project fields, so
 * trying twice is visibly refused rather than silently retried, and pushing
 * for real talks to a live Invoice Ninja instance via
 * `@loxep/integration-invoiceninja`.
 */
export default function PushDraftInvoiceDialog({
  open,
  onOpenChange
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [connectionId, setConnectionId] = React.useState('');
  const [counterpartyId, setCounterpartyId] = React.useState('');
  const [projectId, setProjectId] = React.useState('');
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()]);

  const connectionsQuery = useQuery(invoiceNinjaConnectionsQuery);
  const counterpartiesQuery = useQuery(counterpartyBillingSearchQuery(''));
  const trimmedProjectId = projectId.trim();
  const pushStatusQuery = useQuery(
    draftInvoicePushStatusQuery({
      counterpartyId: counterpartyId === '' ? null : counterpartyId,
      projectId: trimmedProjectId === '' ? null : trimmedProjectId
    })
  );

  const mutation = useMutation({
    mutationFn: () =>
      pushDraftInvoice({
        data: {
          connectionId,
          counterpartyId,
          projectId: trimmedProjectId === '' ? null : trimmedProjectId,
          lines: lines.map((line) => ({
            description: line.description.trim(),
            quantity: line.quantity,
            unitCost: line.unitCost
          }))
        }
      }),
    onSuccess: (result) => {
      toast.success(
        result.alreadyPushed
          ? 'A draft invoice was already pushed for this selection — reused the existing link.'
          : 'Draft invoice pushed to Invoice Ninja.'
      );
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      resetAndClose();
    },
    onError: (error) => toastError(error, 'Failed to push draft invoice')
  });

  const unbilledWorkMutation = useMutation({
    mutationFn: () =>
      listUnbilledWorkForBilling({
        data: { counterpartyId, projectId: trimmedProjectId === '' ? null : trimmedProjectId }
      }),
    onSuccess: (rows) => {
      if (rows.length === 0) {
        toast.info('No unbilled time or materials found for this selection.');
        return;
      }
      setLines((current) => {
        const withoutBlankPlaceholder = current.filter(
          (line) => line.description.trim() !== '' || line.unitCost !== ''
        );
        const loaded = rows.map((row): DraftLine => ({
          description: row.description,
          quantity: row.quantity,
          unitCost: row.unitCost ?? ''
        }));
        return [...withoutBlankPlaceholder, ...loaded];
      });
      toast.success(`Loaded ${rows.length} unbilled line${rows.length === 1 ? '' : 's'}.`);
    },
    onError: (error) => toastError(error, 'Failed to load unbilled work')
  });

  function resetAndClose() {
    setConnectionId('');
    setCounterpartyId('');
    setProjectId('');
    setLines([emptyLine()]);
    onOpenChange(false);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (connectionId === '') {
      toast.error('Choose an Invoice Ninja connection.');
      return;
    }
    if (counterpartyId === '') {
      toast.error('Choose a counterparty.');
      return;
    }
    if (!linesAreValid(lines)) {
      toast.error('Every line needs a description and positive decimal quantity/unit cost.');
      return;
    }
    mutation.mutate();
  }

  const connections = connectionsQuery.data ?? [];
  const counterparties = counterpartiesQuery.data ?? [];

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) resetAndClose();
        else onOpenChange(next);
      }}
    >
      <ResponsiveDialogContent className='max-h-[85vh] overflow-y-auto sm:max-w-[560px]'>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Push draft invoice to Invoice Ninja</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Creates a DRAFT invoice in Invoice Ninja for the chosen counterparty. Loxep records the
            linkage via external_resources/resource_links
            (purpose=&apos;billing_invoice_draft&apos;); re-pushing the same counterparty/project
            reuses the existing link instead of creating a second draft. Shows up to 10
            counterparties, alphabetically.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <form className='space-y-6' onSubmit={handleSubmit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor='push-draft-invoice-connection'>
                Invoice Ninja connection
              </FieldLabel>
              <Select value={connectionId} onValueChange={setConnectionId}>
                <SelectTrigger id='push-draft-invoice-connection' className='w-full'>
                  <SelectValue
                    placeholder={connectionsQuery.isLoading ? 'Loading…' : 'Select a connection'}
                  />
                </SelectTrigger>
                <SelectContent>
                  {connections.length === 0 && !connectionsQuery.isLoading && (
                    <div className='px-2 py-1.5 text-sm text-muted-foreground'>
                      No Invoice Ninja connections yet — add one under Settings → Integrations.
                    </div>
                  )}
                  {connections.map((connection) => (
                    <SelectItem key={connection.id} value={connection.id}>
                      {connection.externalAccountName
                        ? `${connection.name} (${connection.externalAccountName})`
                        : connection.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor='push-draft-invoice-counterparty'>Counterparty</FieldLabel>
              <Select value={counterpartyId} onValueChange={setCounterpartyId}>
                <SelectTrigger id='push-draft-invoice-counterparty' className='w-full'>
                  <SelectValue
                    placeholder={
                      counterpartiesQuery.isLoading ? 'Loading…' : 'Select a counterparty'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {counterparties.length === 0 && !counterpartiesQuery.isLoading && (
                    <div className='px-2 py-1.5 text-sm text-muted-foreground'>
                      No counterparties found.
                    </div>
                  )}
                  {counterparties.map((counterparty) => (
                    <SelectItem key={counterparty.id} value={counterparty.id}>
                      {counterparty.displayName} ({counterparty.referenceCode})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor='push-draft-invoice-project-id'>Project id (optional)</FieldLabel>
              <Input
                id='push-draft-invoice-project-id'
                placeholder='Leave blank for a counterparty-level push'
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              />
            </Field>
          </FieldGroup>

          {pushStatusQuery.data && (
            <Alert>
              <Icons.info />
              <AlertTitle>Already pushed</AlertTitle>
              <AlertDescription>
                This {trimmedProjectId === '' ? 'counterparty' : 'project'} already has an open
                draft push ({pushStatusQuery.data.title ?? 'unnumbered'}, linked{' '}
                {new Date(pushStatusQuery.data.linkedAt).toLocaleDateString()}). Submitting again
                reuses that link rather than creating a new draft.
              </AlertDescription>
            </Alert>
          )}

          <div className='space-y-3'>
            <div className='flex items-center justify-between'>
              <span className='text-sm font-medium'>Line items</span>
              <div className='flex gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={counterpartyId === '' || unbilledWorkMutation.isPending}
                  onClick={() => unbilledWorkMutation.mutate()}
                >
                  {unbilledWorkMutation.isPending ? (
                    <Icons.spinner className='animate-spin' />
                  ) : (
                    <Icons.checks />
                  )}
                  Load unbilled work
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => setLines((current) => [...current, emptyLine()])}
                >
                  <Icons.add />
                  Add line
                </Button>
              </div>
            </div>
            <p className='text-xs text-muted-foreground'>
              &quot;Load unbilled work&quot; appends billable, unbilled time entries and material
              uses for this counterparty/project as editable rows — review quantities and unit costs
              (blank when a rate was never resolved) before submitting.
            </p>
            {lines.map((line, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={index} className='grid grid-cols-[1fr_5rem_6rem_2rem] items-end gap-2'>
                <Field>
                  {index === 0 && <FieldLabel>Description</FieldLabel>}
                  <Input
                    placeholder='e.g. Consulting hours'
                    value={line.description}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, description: event.target.value } : row
                        )
                      )
                    }
                  />
                </Field>
                <Field>
                  {index === 0 && <FieldLabel>Qty</FieldLabel>}
                  <Input
                    inputMode='decimal'
                    placeholder='1'
                    value={line.quantity}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, quantity: event.target.value } : row
                        )
                      )
                    }
                  />
                </Field>
                <Field>
                  {index === 0 && <FieldLabel>Unit cost</FieldLabel>}
                  <Input
                    inputMode='decimal'
                    placeholder='0.00'
                    value={line.unitCost}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((row, i) =>
                          i === index ? { ...row, unitCost: event.target.value } : row
                        )
                      )
                    }
                  />
                </Field>
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  disabled={lines.length === 1}
                  onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                >
                  <Icons.trash />
                </Button>
              </div>
            ))}
          </div>

          <div className='flex justify-end gap-2'>
            <Button type='button' variant='outline' onClick={resetAndClose}>
              Cancel
            </Button>
            <Button type='submit' disabled={mutation.isPending}>
              {mutation.isPending && <Icons.spinner className='animate-spin' />}
              Push draft invoice
            </Button>
          </div>
        </form>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
