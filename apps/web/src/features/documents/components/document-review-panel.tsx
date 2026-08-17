import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { z } from 'zod';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle
} from '@/components/ui/responsive-dialog';
import { FieldGroup } from '@/components/ui/field';
import { InfoButton } from '@/components/ui/info-button';
import type { InfobarContent } from '@/components/ui/infobar';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { DocumentPreview, type DocumentPreviewOverlayLine } from '@/components/document-preview';
import { Icons } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError } from '@/lib/errors';
import { useAppForm } from '@/lib/form';
import {
  confirmLinesAsAcquisition,
  confirmLinesAsExpense,
  confirmLinesAsIntake,
  discardDocument,
  setLineDisposition
} from '@/server/documents-functions';
import { documentQuery } from '@/features/documents/api/queries';
import { entitiesQuery } from '@/features/settings/api/queries';
import { inventoryLocationsQuery } from '@/features/inventory/api/queries';
import { itemConditionOptions } from '@/features/inventory/constants';
import {
  ACQUISITION_LOT_DISPOSITIONS,
  CONFIRMABLE_AS_INTAKE_DISPOSITIONS,
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
import AcquisitionLotPickerDialog from './acquisition-lot-picker';
import type { AcquisitionLotTarget } from './acquisition-lot-picker';

const NO_LOCATION_VALUE = '__no_location__';

const CONFIRM_TO_LOT_INFO: InfobarContent = {
  title: 'Confirm to a lot',
  sections: [
    {
      title: 'Acquisition cost vs. stock',
      description:
        'Money that bought goods for resale becomes an acquisition — never an expense. "Cost of a lot" lines become cost components; "Stock (inventory)" lines become actual items. Both target the same lot, confirmed with two separate actions.'
    },
    {
      title: 'Stock intake',
      description:
        'Lines dispositioned "Stock (inventory)" become physical stock, in intake status, same as any other item. Condition and location apply to every item this confirms.'
    }
  ]
};

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
 * line, and THREE independent batch confirm actions — "Confirm as expense"
 * (`expense`/`supplies` lines), "Confirm as acquisition cost"
 * (`acquisition_cost` lines, loxep-cd3.6, M6), and "Confirm as intake"
 * (`inventory_intake` lines, loxep-ytu). A mixed receipt (three items to
 * flip, plus tape, plus tax) runs the expense action for the tape AND the
 * acquisition-cost action for the tax AND the intake action for the three
 * items — that is the "one document, two records" rule
 * (`expense-entry-design.md` section 4) extended to three, not a single call
 * that mixes dispositions: each confirm is homogeneous to its own target.
 * `acquisition_cost` becomes an `acquisition_costs` row (a money fact);
 * `inventory_intake` becomes an ACTUAL `inventory_items` row (physical
 * stock) — never a cost row, per `@loxep/inventory`'s `confirm.ts` top doc.
 *
 * Dispositioning a line as `acquisition_cost`/`inventory_intake` opens the
 * acquisition-lot picker so the operator resolves WHICH lot the line belongs
 * to before confirming — existing open lots plus a create-new-draft inline
 * form. Both the cost and intake actions target the SAME chosen lot.
 */
export default function DocumentReviewPanel({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const [discardOpen, setDiscardOpen] = React.useState(false);
  const [lotPickerOpen, setLotPickerOpen] = React.useState(false);
  const [acquisitionTarget, setAcquisitionTarget] = React.useState<AcquisitionLotTarget | null>(
    null
  );
  const [intakeConditionCode, setIntakeConditionCode] = React.useState('unknown');
  const [intakeLocationId, setIntakeLocationId] = React.useState(NO_LOCATION_VALUE);

  const { data: document, isPending, isError, refetch } = useQuery(documentQuery(documentId));
  const { data: entities } = useQuery(entitiesQuery);
  const { data: locations } = useQuery(inventoryLocationsQuery);

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
      // Every confirmed candidate becomes ONE line on the SAME expense
      // (loxep-cd3.3, M3) — no longer one expense per candidate. The
      // created expense id itself is surfaced non-transiently, not just in
      // this toast: `invalidate()` refetches the document, and each
      // now-confirmed row in `CandidatesTable` renders its `targetKind`/
      // `targetId` as a link to `/finance/expenses/$id` (loxep-0l5).
      if (result.expenseId === null) {
        toast.error('Nothing confirmable — every selected line was already resolved');
      } else {
        toast.success(`Confirmed ${result.lineCount} line(s) onto one expense`);
      }
      invalidate();
    },
    onError: (error) => toastError(error, 'Could not confirm the selected lines')
  });

  const acquisitionConfirmMutation = useMutation({
    mutationFn: (input: { candidateIds: string[]; acquisitionId: string }) =>
      confirmLinesAsAcquisition({
        data: {
          documentId,
          candidateIds: input.candidateIds,
          acquisitionId: input.acquisitionId,
          defaultCurrency: document?.currency ?? 'USD'
        }
      }),
    onSuccess: (result) => {
      if (result.acquisitionId === null) {
        toast.error('Nothing confirmable — every selected line was already resolved');
      } else {
        toast.success(
          `Confirmed ${result.costCount} cost line(s) onto ${result.acquisitionReferenceCode}`
        );
      }
      invalidate();
    },
    onError: (error) => toastError(error, 'Could not confirm the selected lines')
  });

  const intakeConfirmMutation = useMutation({
    mutationFn: (input: {
      candidateIds: string[];
      acquisitionId: string;
      conditionCode: string;
      locationId: string | null;
    }) =>
      confirmLinesAsIntake({
        data: {
          documentId,
          candidateIds: input.candidateIds,
          acquisitionId: input.acquisitionId,
          defaultCurrency: document?.currency ?? 'USD',
          conditionCode: input.conditionCode as never,
          locationId: input.locationId
        }
      }),
    onSuccess: (result) => {
      if (result.acquisitionId === null) {
        toast.error('Nothing confirmable — every selected line was already resolved');
      } else {
        toast.success(
          `Confirmed ${result.itemCount} item(s) onto ${result.acquisitionReferenceCode}`
        );
      }
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
  const readyAcquisitionCandidates = document.candidates.filter(
    (c) => c.confirmedAt === null && ACQUISITION_LOT_DISPOSITIONS.has(c.disposition as never)
  );
  const readyIntakeCandidates = readyAcquisitionCandidates.filter((c) =>
    CONFIRMABLE_AS_INTAKE_DISPOSITIONS.has(c.disposition as never)
  );
  const readyAcquisitionCostCandidates = readyAcquisitionCandidates.filter(
    (c) => !CONFIRMABLE_AS_INTAKE_DISPOSITIONS.has(c.disposition as never)
  );
  const readyAcquisitionCount = readyAcquisitionCostCandidates.length;
  const readyIntakeCount = readyIntakeCandidates.length;
  const locationOptions = [
    { value: NO_LOCATION_VALUE, label: 'Unassigned' },
    ...(locations ?? []).map((location) => ({
      value: location.id,
      label: `${location.code} — ${location.name}`
    }))
  ];

  // The highlight overlay (loxep-cd3.5, M5) — the SAME `<DocumentPreview>`
  // overlay mode the evidence pane uses (`expense-entry-design.md`'s "the
  // weave" calls for the two flows to share one mechanism), mounted
  // read-only here: this panel already has its own confirm mechanism (the
  // disposition `Select` + batch "Confirm as..." actions above), so the
  // overlay's job is spatial context — "here is where on the receipt this
  // line came from" — not a second drop target. `draggable` stays unset
  // (mouse-drag is a no-op with no target to land on); every line still
  // gets its `document_line_candidates.id`-keyed identity in case a future
  // pass wants to wire a drop target here too.
  const overlayLines: DocumentPreviewOverlayLine[] = document.candidates.flatMap((candidate) =>
    candidate.sourceRegion === null
      ? []
      : [
          {
            id: candidate.id,
            documentId: candidate.documentId,
            lineNumber: candidate.lineNumber,
            text: candidate.description ?? '',
            region: candidate.sourceRegion
          }
        ]
  );

  function handleDispositionChange(candidateId: string, disposition: string) {
    dispositionMutation.mutate({ candidateId, disposition });
    // Opens the lot picker the FIRST time an operator routes a line toward
    // inventory — once a target lot is chosen it stays chosen for the rest
    // of this review session, so later lines with the same disposition just
    // join the same "Confirm as acquisition" batch below.
    if (ACQUISITION_LOT_DISPOSITIONS.has(disposition as never) && !acquisitionTarget) {
      setLotPickerOpen(true);
    }
  }

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
              onDispositionChange={handleDispositionChange}
            />
          )}

          {document.sourceKind === 'upload' && (
            <ManualLineForm documentId={documentId} onAdded={invalidate} />
          )}
        </div>

        <div className='space-y-4'>
          {document.mediaServingUrl && (
            <DocumentPreview
              mimeType={document.mimeType}
              servingUrl={document.mediaServingUrl}
              alt={document.originalFilename ?? 'Uploaded document'}
              className='max-h-96'
              overlay={overlayLines.length > 0 ? { lines: overlayLines } : undefined}
            />
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

          {(readyAcquisitionCount > 0 || readyIntakeCount > 0) && (
            <div className='space-y-3 rounded-md border p-4'>
              <div className='flex items-center gap-1.5'>
                <p className='text-sm font-medium'>Confirm to a lot</p>
                <InfoButton content={CONFIRM_TO_LOT_INFO} className='size-6' />
              </div>
              {acquisitionTarget ? (
                <div className='flex flex-wrap items-center gap-2 text-sm'>
                  <span className='text-muted-foreground'>Lot:</span>
                  <Badge variant='secondary'>{acquisitionTarget.referenceCode}</Badge>
                  <span className='truncate'>{acquisitionTarget.title}</span>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={() => setLotPickerOpen(true)}
                  >
                    Change
                  </Button>
                </div>
              ) : (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  onClick={() => setLotPickerOpen(true)}
                >
                  <Icons.add />
                  Choose a lot
                </Button>
              )}

              {readyAcquisitionCount > 0 && (
                <div className='space-y-2 border-t pt-3'>
                  <p className='text-muted-foreground text-xs'>
                    {readyAcquisitionCount} line(s) dispositioned "Cost of a lot".
                  </p>
                  <Button
                    type='button'
                    disabled={!acquisitionTarget || acquisitionConfirmMutation.isPending}
                    onClick={() => {
                      if (!acquisitionTarget) return;
                      acquisitionConfirmMutation.mutate({
                        candidateIds: readyAcquisitionCostCandidates.map((c) => c.id),
                        acquisitionId: acquisitionTarget.id
                      });
                    }}
                  >
                    Confirm {readyAcquisitionCount} as acquisition cost
                  </Button>
                </div>
              )}

              {readyIntakeCount > 0 && (
                <div className='space-y-3 border-t pt-3'>
                  <p className='text-muted-foreground text-xs'>
                    {readyIntakeCount} line(s) dispositioned "Stock (inventory)".
                  </p>
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <Select value={intakeConditionCode} onValueChange={setIntakeConditionCode}>
                      <SelectTrigger size='sm'>
                        <SelectValue placeholder='Condition' />
                      </SelectTrigger>
                      <SelectContent>
                        {itemConditionOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={intakeLocationId} onValueChange={setIntakeLocationId}>
                      <SelectTrigger size='sm'>
                        <SelectValue placeholder='Location' />
                      </SelectTrigger>
                      <SelectContent>
                        {locationOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type='button'
                    disabled={!acquisitionTarget || intakeConfirmMutation.isPending}
                    onClick={() => {
                      if (!acquisitionTarget) return;
                      intakeConfirmMutation.mutate({
                        candidateIds: readyIntakeCandidates.map((c) => c.id),
                        acquisitionId: acquisitionTarget.id,
                        conditionCode: intakeConditionCode,
                        locationId: intakeLocationId === NO_LOCATION_VALUE ? null : intakeLocationId
                      });
                    }}
                  >
                    Confirm {readyIntakeCount} as intake
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <AcquisitionLotPickerDialog
        open={lotPickerOpen}
        onOpenChange={setLotPickerOpen}
        onSelected={setAcquisitionTarget}
        defaultTitle={document.originalFilename ?? document.counterpartyName ?? undefined}
        defaultVendorName={document.counterpartyName}
        defaultCurrency={document.currency}
      />

      <ResponsiveDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Discard this document?</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Every unresolved line is marked "Discard" — this is for throwing out a review before
              anything was confirmed, and cannot run once a line has been confirmed.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogFooter>
            <Button variant='outline' onClick={() => setDiscardOpen(false)}>
              Cancel
            </Button>
            <Button variant='destructive' onClick={() => discardMutation.mutate(null)}>
              Discard
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}
