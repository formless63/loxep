import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { FieldGroup } from '@/components/ui/field';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import {
  confirmLinesAsExpense,
  discardDocument,
  setLineDisposition
} from '@/server/documents-functions';
import { documentQuery } from '@/features/documents/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import {
  CONFIRMABLE_DISPOSITIONS,
  documentStatusLabel,
  documentStatusTone
} from '@/features/documents/constants';
import {
  paymentMethodOptions,
  SUGGESTED_EXPENSE_CATEGORIES,
  UNATTRIBUTED_ENTITY_VALUE
} from '@/features/finance/constants';
import ManualLineForm from './manual-line-form';
import CandidatesTable from './candidates-table';

const confirmSchema = z.object({
  category: z.string().trim().min(1, 'Category is required'),
  paymentMethod: z.enum([
    'card',
    'cash',
    'bank_transfer',
    'marketplace_balance',
    'direct_debit',
    'other'
  ]),
  economicEntityId: z.string()
});

/**
 * One document's review screen: side-by-side receipt image (when uploaded)
 * and its staged/transcribed candidate lines on the right, a disposition per
 * line, and a batch "Confirm as expense" action. `acquisition_cost`/
 * `inventory_intake` dispositions are offered on the row but not yet
 * confirmable — see `CONFIRMABLE_DISPOSITIONS`'s doc for the deferred note.
 */
export default function DocumentReviewPanel({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const [discardOpen, setDiscardOpen] = React.useState(false);

  const { data: document, isPending, isError, refetch } = useQuery(documentQuery(documentId));
  const { data: entities } = useQuery(entitiesQuery);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['documents'] });
  };

  const dispositionMutation = useMutation({
    mutationFn: (input: { candidateId: string; disposition: string }) =>
      setLineDisposition({
        data: { candidateId: input.candidateId, disposition: input.disposition as never }
      }),
    onSuccess: invalidate,
    onError: (error) => toastError(error, 'Could not update the disposition')
  });

  const confirmMutation = useMutation({
    mutationFn: (input: {
      candidateIds: string[];
      category: string;
      paymentMethod: string;
      economicEntityId: string | null;
    }) =>
      confirmLinesAsExpense({
        data: {
          documentId,
          candidateIds: input.candidateIds,
          category: input.category,
          paymentMethod: input.paymentMethod as never,
          economicEntityId: input.economicEntityId,
          defaultCurrency: document?.currency ?? 'USD'
        }
      }),
    onSuccess: (result) => {
      // The created expense ids themselves are surfaced non-transiently, not
      // just in this toast: `invalidate()` refetches the document, and each
      // now-confirmed row in `CandidatesTable` renders its `targetKind`/
      // `targetId` as a link to `/finance/expenses/$id` (loxep-0l5).
      toast.success(`Confirmed ${result.expenseIds.length} expense(s)`);
      invalidate();
    },
    onError: (error) => toastError(error, 'Could not confirm the selected lines')
  });

  const discardMutation = useMutation({
    mutationFn: (reason: string | null) => discardDocument({ data: { documentId, reason } }),
    onSuccess: () => {
      toast.success('Document discarded');
      setDiscardOpen(false);
      invalidate();
    },
    onError: (error) => toastError(error, 'Could not discard this document')
  });

  const form = useAppForm({
    defaultValues: {
      category: '',
      paymentMethod: 'card',
      economicEntityId: UNATTRIBUTED_ENTITY_VALUE
    } as z.infer<typeof confirmSchema>,
    validators: { onSubmit: confirmSchema },
    onSubmit: async ({ value }) => {
      const readyIds =
        document?.candidates
          .filter(
            (c) => c.confirmedAt === null && CONFIRMABLE_DISPOSITIONS.has(c.disposition as never)
          )
          .map((c) => c.id) ?? [];
      if (readyIds.length === 0) {
        toast.error('No lines are dispositioned "Expense" or "Supplies" yet');
        return;
      }
      await confirmMutation.mutateAsync({
        candidateIds: readyIds,
        category: value.category,
        paymentMethod: value.paymentMethod,
        economicEntityId:
          value.economicEntityId === UNATTRIBUTED_ENTITY_VALUE ? null : value.economicEntityId
      });
    }
  });

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }
  if (isError || !document) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.warning />
          </EmptyMedia>
          <EmptyTitle>Could not load this document</EmptyTitle>
          <EmptyDescription>
            <Button size='sm' variant='outline' onClick={() => refetch()}>
              Retry
            </Button>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const readyCount = document.candidates.filter(
    (c) => c.confirmedAt === null && CONFIRMABLE_DISPOSITIONS.has(c.disposition as never)
  ).length;

  return (
    <div className='space-y-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Badge variant={documentStatusTone(document.status)}>
            {documentStatusLabel(document.status)}
          </Badge>
          <span className='text-muted-foreground text-sm'>
            {document.confirmedCount} of {document.lineCount} line(s) confirmed
          </span>
        </div>
        {document.status !== 'discarded' && document.confirmedCount === 0 && (
          <Button size='sm' variant='outline' onClick={() => setDiscardOpen(true)}>
            <Icons.trash />
            Discard document
          </Button>
        )}
      </div>

      <div className='grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]'>
        <div className='space-y-4'>
          {document.candidates.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.fees />
                </EmptyMedia>
                <EmptyTitle>No lines yet</EmptyTitle>
                <EmptyDescription>
                  No parser reads this document automatically (manual-assisted only, this milestone)
                  — transcribe it by hand below.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <CandidatesTable
              candidates={document.candidates}
              onDispositionChange={(candidateId, disposition) =>
                dispositionMutation.mutate({ candidateId, disposition })
              }
            />
          )}

          {document.sourceKind === 'upload' && (
            <ManualLineForm documentId={documentId} onAdded={invalidate} />
          )}
        </div>

        <div className='space-y-4'>
          {document.mediaServingUrl && (
            <a
              href={document.mediaServingUrl}
              target='_blank'
              rel='noreferrer'
              className='block overflow-hidden rounded-md border'
            >
              <img
                src={document.mediaServingUrl}
                alt={document.originalFilename ?? 'Uploaded document'}
                className='h-auto w-full object-contain'
              />
            </a>
          )}

          <form
            className='space-y-4 rounded-md border p-4'
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <p className='text-sm font-medium'>Confirm as expense</p>
            <p className='text-muted-foreground text-xs'>
              Applies to every unconfirmed line currently dispositioned "Expense" or "Supplies" —{' '}
              {readyCount} right now. The parser only PROPOSES; nothing is written until you
              confirm.
            </p>
            <FieldGroup>
              <form.AppField
                name='category'
                children={(field) => (
                  <div>
                    <field.TextField
                      label='Category'
                      required
                      list='documents-category-suggestions'
                      placeholder='e.g. shipping_supplies'
                    />
                    <datalist id='documents-category-suggestions'>
                      {SUGGESTED_EXPENSE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </datalist>
                  </div>
                )}
              />
              <form.AppField
                name='paymentMethod'
                children={(field) => (
                  <field.SelectField label='Payment' required options={paymentMethodOptions} />
                )}
              />
              <form.AppField
                name='economicEntityId'
                children={(field) => (
                  <field.SelectField
                    label='Entity'
                    options={[
                      { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
                      ...(entities ?? []).map((entity) => ({
                        value: entity.id,
                        label: entity.name
                      }))
                    ]}
                  />
                )}
              />
            </FieldGroup>
            <form.AppForm>
              <form.SubmitButton disabled={readyCount === 0}>
                Confirm {readyCount} as expense
              </form.SubmitButton>
            </form.AppForm>
          </form>
        </div>
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this document?</DialogTitle>
            <DialogDescription>
              Every unresolved line is marked "Discard" — this is for throwing out a review before
              anything was confirmed, and cannot run once a line has been confirmed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setDiscardOpen(false)}>
              Cancel
            </Button>
            <Button variant='destructive' onClick={() => discardMutation.mutate(null)}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
