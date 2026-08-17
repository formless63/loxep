import * as React from 'react';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldError, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { DocumentPreviewOverlayLine } from '@/components/document-preview';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useAppForm } from '@/lib/form';
import { createExpenseWithEvidence } from '@/server/expense-functions';
import { entitiesQuery } from '@/features/settings/api/queries';
import EvidencePane, { type EvidenceAttachment } from '@/features/finance/components/evidence-pane';
import {
  DocumentLineDndProvider,
  DocumentLineDropTarget,
  extractProvisionalAmount,
  type DraggedDocumentLine
} from '@/features/finance/components/document-line-dnd';
import {
  NO_TRADING_PARTNER_VALUE,
  PayeeComboboxField
} from '@/features/finance/components/payee-combobox-field';
import {
  paymentMethodOptions,
  SUGGESTED_EXPENSE_CATEGORIES,
  UNATTRIBUTED_ENTITY_VALUE
} from '@/features/finance/constants';

const DEFAULT_CURRENCY = 'USD';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * One row of the optional line-items editor (loxep-cd3.3, M3 —
 * `expense-entry-design.md` section 4). `lineAmount` is the only required
 * field, matching `expense_lines`' own schema — `quantity`/`unitAmount` are
 * informational and never derive it. Composed here, in the SAME form as the
 * expense itself, because the expense does not exist yet at compose time —
 * the part-out dialog's `children` array (`@/features/inventory/components/
 * part-out-dialog.tsx`) is the precedent for an in-form array of objects
 * over a parallel `useState` list.
 */
const lineItemSchema = z.object({
  description: z.string().trim(),
  quantity: z.string().trim(),
  unitAmount: z.string().trim(),
  lineAmount: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d{1,6})?$/, 'Enter an amount, e.g. 12.50')
});

const newExpenseSchema = z.object({
  payeeName: z.string(),
  payeeCounterpartyId: z.string(),
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date'),
  amount: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,6})?$/, 'Enter a positive amount, e.g. 12.50'),
  taxAmount: z.string().trim(),
  category: z.string().trim().min(1, 'Category is required'),
  paymentMethod: z.enum([
    'card',
    'cash',
    'bank_transfer',
    'marketplace_balance',
    'direct_debit',
    'other'
  ]),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/, 'A 3-letter currency code, e.g. USD'),
  economicEntityId: z.string(),
  notes: z.string(),
  lines: z.array(lineItemSchema)
});

type NewExpenseFormValues = z.infer<typeof newExpenseSchema>;

export interface NewExpensePrefill {
  amount?: string;
  expenseDate?: string;
  category?: string;
  payeeName?: string;
  paymentMethod?: string;
  currency?: string;
  economicEntityId?: string;
}

/**
 * A receipt line dragged onto (or "used" via keyboard for) the "Line items"
 * drop zone (loxep-cd3.5, M5). Deliberately NOT the same shape as
 * `lineItemSchema`'s typed rows above: this one carries a `document_line_candidates.id`
 * and the operator NEVER edits its `description` (the OCR'd text stays
 * verbatim — see `document-preview.tsx`'s own doc), only its provisional
 * `lineAmount`, because that is the one value tier B declines to guess (the
 * design's tier C refusal) and the design's "dragging changes nothing in
 * the database" rule means nothing here is written until save.
 */
interface PinnedDocumentLine {
  candidateId: string;
  documentId: string;
  description: string;
  /** The client-side "rightmost decimal token" guess, or the operator's own correction — PROVISIONAL until Save. */
  lineAmount: string;
}

/**
 * The keyboard/click equivalent for a detected line (`document-preview.tsx`'s
 * `renderActions` seam) — every action a drag onto this page can perform,
 * reachable without a pointer. Mirrors the drop targets below exactly: "Add
 * to line items" calls the SAME `addPinnedLine` a lines-list drop calls;
 * "Fill payee/amount/category" call the SAME field setters a field drop
 * calls. No action here does anything a drag could not already do.
 */
function UseLineMenu({
  line,
  onAddToLines,
  onFillPayee,
  onFillAmount,
  onFillCategory
}: {
  line: DocumentPreviewOverlayLine;
  onAddToLines: (line: DocumentPreviewOverlayLine) => void;
  onFillPayee: (text: string) => void;
  onFillAmount: (text: string) => void;
  onFillCategory: (text: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='shrink-0'
          aria-label={`Use this line: "${line.text}"`}
        >
          Use…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem onSelect={() => onAddToLines(line)}>Add to line items</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFillPayee(line.text)}>Fill payee name</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFillAmount(line.text)}>Fill amount</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onFillCategory(line.text)}>
          Fill category
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * `/finance/expenses/new`'s two-pane body (loxep-cd3.2, M2 —
 * `expense-entry-design.md` section 1's layout diagram): the entry form on
 * the left, the evidence pane on the right, side by side on desktop and
 * stacked (form first) below `md` — never a modal, never a tab, never a
 * separate route, because the whole point is that the receipt and the
 * fields are visible at once.
 *
 * **Mobile (loxep-45k, rule M5):** below 768px a sticky "Form | Evidence"
 * segmented toggle sits above the stack so a long form (or a receipt with
 * several pages) never leaves the other pane a long scroll away. Both panes
 * stay mounted at every width — the toggle only switches which one is
 * `hidden` below `md` via plain CSS (`hidden md:block`), never `useIsMobile`
 * — so resizing across 768px, or a `>=md` viewport where the toggle itself
 * is `md:hidden`, always shows both panes with no JS-driven remount and no
 * lost pending upload/selection state in `EvidencePane`.
 *
 * `useAppForm` only, per Frontend Standards — no raw `<Input>` + `useState`.
 * "Save as draft" and "Record expense" are two DISTINCT buttons (the
 * design's own mockup), not a toggle field: each sets the intended status
 * then submits, rather than one submit whose meaning depends on a switch the
 * operator might not notice.
 *
 * **The payee seam (M1, landing concurrently as loxep-cd3.1):**
 * `expense-entry-design.md` section 2 designs a counterparty combobox with
 * inline "+ New trading partner" create. `createExpenseWithEvidence` already
 * accepts an optional `payeeCounterpartyId` (mirroring `createExpense`'s own
 * quick-entry field, `@/server/expense-functions.ts`) — "both are written,
 * always" per the design, so once a picker exists here it needs no server
 * change, only a value to pass. As of this milestone no picker COMPONENT
 * exists yet under `apps/web/src` to mount (only `@/server/
 * trading-partner-functions.ts`'s server functions do), so this field stays
 * a plain text input writing `payeeName` only, exactly like the quick-entry
 * dialog's own Payee field — free text alone stays valid per the design ("a
 * thrift-store receipt from a shop with no name is a real expense"). Swap
 * this `field.TextField` for the picker component when it lands, wiring its
 * resolved id into the `payeeCounterpartyId` the mutation already sends as
 * `null`; no other change on this page should be required.
 */
export default function NewExpensePage({ prefill }: { prefill?: NewExpensePrefill }) {
  const { data: entities } = useSuspenseQuery(entitiesQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [attachments, setAttachments] = React.useState<EvidenceAttachment[]>([]);
  const [pinnedLines, setPinnedLines] = React.useState<PinnedDocumentLine[]>([]);
  const [hoveredLineId, setHoveredLineId] = React.useState<string | null>(null);
  // Mobile-only (M5) — which pane the sticky toggle currently shows below
  // `md`; irrelevant at `>=md`, where both panes render unconditionally.
  const [activePane, setActivePane] = React.useState<'form' | 'evidence'>('form');

  const entityOptions = [
    { value: UNATTRIBUTED_ENTITY_VALUE, label: 'Unattributed' },
    ...entities.map((entity) => ({ value: entity.id, label: entity.name }))
  ];

  // The "Line items" drop zone's own handler (loxep-cd3.5, M5) — adds a
  // dragged/keyboard-"used" line ONCE (re-dropping the same line updates its
  // provisional amount rather than duplicating the row; `document_line_candidates.id`
  // is stable identity for this). Never touches the database — see
  // `document-line-dnd.tsx`'s doc.
  function addPinnedLine(line: DraggedDocumentLine) {
    setPinnedLines((prev) => {
      if (prev.some((pinned) => pinned.candidateId === line.candidateId)) return prev;
      return [
        ...prev,
        {
          candidateId: line.candidateId,
          documentId: line.documentId,
          description: line.text,
          lineAmount: extractProvisionalAmount(line.text) ?? ''
        }
      ];
    });
  }

  const mutation = useMutation({
    mutationFn: (input: { values: NewExpenseFormValues; status: 'draft' | 'recorded' }) => {
      const mediaObjectIds = attachments
        .filter((attachment) => attachment.status === 'uploaded' && attachment.mediaObjectId)
        .map((attachment) => attachment.mediaObjectId as string);
      const { values } = input;
      return createExpenseWithEvidence({
        data: {
          amount: values.amount,
          taxAmount: values.taxAmount.trim() === '' ? null : values.taxAmount.trim(),
          expenseDate: values.expenseDate,
          category: values.category,
          payeeName: values.payeeName.trim() === '' ? null : values.payeeName.trim(),
          payeeCounterpartyId:
            values.payeeCounterpartyId === NO_TRADING_PARTNER_VALUE
              ? null
              : values.payeeCounterpartyId,
          paymentMethod: values.paymentMethod,
          currency: values.currency.toUpperCase(),
          economicEntityId:
            values.economicEntityId === UNATTRIBUTED_ENTITY_VALUE ? null : values.economicEntityId,
          status: input.status,
          notes: values.notes.trim() === '' ? null : values.notes.trim(),
          mediaObjectIds,
          lines: values.lines.map((line) => ({
            description: line.description.trim() === '' ? null : line.description.trim(),
            quantity: line.quantity.trim() === '' ? null : line.quantity.trim(),
            unitAmount: line.unitAmount.trim() === '' ? null : line.unitAmount.trim(),
            lineAmount: line.lineAmount.trim()
          })),
          droppedLines: pinnedLines.map((pinned) => ({
            documentId: pinned.documentId,
            candidateId: pinned.candidateId,
            lineAmount: pinned.lineAmount.trim()
          }))
        }
      });
    },
    onSuccess: (result) => {
      const suffixes = [
        result.attachedCount > 0 ? `${result.attachedCount} attachment(s)` : null,
        result.lineCount > 0 ? `${result.lineCount} line(s)` : null
      ].filter((suffix): suffix is string => suffix !== null);
      toast.success(
        suffixes.length > 0
          ? `Expense ${result.referenceCode} recorded with ${suffixes.join(' and ')}`
          : `Expense ${result.referenceCode} recorded`
      );
      // Prefix-matches every finance query key (list, detail, reports) — same
      // invalidation `QuickExpenseDialog` uses.
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
      void navigate({ to: '/finance/expenses/$id', params: { id: result.id } });
    },
    onError: (error) => toastError(error, 'Failed to record expense')
  });

  // "Save as draft" and "Record expense" are two distinct submit intents,
  // not a switch field — TanStack Form's `onSubmitMeta`/`handleSubmit(meta)`
  // is the sanctioned mechanism for exactly this ("which button" without a
  // parallel manual-validation path): each button passes its own status as
  // submit meta, and the form's normal validate-then-call-onSubmit lifecycle
  // (including `isSubmitting`) runs unchanged either way.
  const form = useAppForm({
    defaultValues: {
      payeeName: prefill?.payeeName ?? '',
      payeeCounterpartyId: NO_TRADING_PARTNER_VALUE,
      expenseDate: prefill?.expenseDate ?? todayIsoDate(),
      amount: prefill?.amount ?? '',
      taxAmount: '',
      category: prefill?.category ?? '',
      paymentMethod: (prefill?.paymentMethod as NewExpenseFormValues['paymentMethod']) ?? 'card',
      currency: prefill?.currency ?? DEFAULT_CURRENCY,
      economicEntityId: prefill?.economicEntityId ?? UNATTRIBUTED_ENTITY_VALUE,
      notes: '',
      lines: []
    } as NewExpenseFormValues,
    onSubmitMeta: { status: 'recorded' as 'draft' | 'recorded' },
    validators: { onSubmit: newExpenseSchema },
    onSubmit: async ({ value, meta }) => {
      // A pinned line's amount is PROVISIONAL (the "rightmost decimal
      // token" client-side guess) until the operator confirms/edits it —
      // never-auto-commit means Loxep does not silently save a guessed
      // number, so an empty amount blocks submit here rather than being
      // coerced to anything.
      const missingAmount = pinnedLines.some((pinned) => pinned.lineAmount.trim() === '');
      if (missingAmount) {
        toast.error(
          'One of the dragged receipt lines has no amount yet — fill it in or remove it.'
        );
        return;
      }
      try {
        await mutation.mutateAsync({ values: value, status: meta.status });
      } catch {
        // Reported through mutation.onError's toast.
      }
    }
  });

  return (
    <DocumentLineDndProvider>
      <div className='grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_360px]'>
        <div className='bg-background sticky top-14 z-10 -mx-4 border-b px-4 py-2 md:hidden'>
          <ToggleGroup
            type='single'
            variant='outline'
            value={activePane}
            onValueChange={(value) => {
              if (value === 'form' || value === 'evidence') setActivePane(value);
            }}
            className='w-full'
          >
            <ToggleGroupItem value='form' className='flex-1'>
              Form
            </ToggleGroupItem>
            <ToggleGroupItem value='evidence' className='flex-1'>
              Evidence
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <Card className={cn(activePane !== 'form' && 'hidden md:flex')}>
          <CardContent className='pt-6'>
            <form
              className='space-y-6'
              onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit({ status: 'recorded' });
              }}
            >
              <FieldGroup>
                <form.Field name='payeeCounterpartyId'>
                  {(field) => (
                    <PayeeComboboxField
                      label='Payee'
                      name='payeeCounterpartyId'
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                      invalid={field.state.meta.isTouched && !field.state.meta.isValid}
                      errors={field.state.meta.errors}
                      economicEntityId={
                        form.state.values.economicEntityId === UNATTRIBUTED_ENTITY_VALUE
                          ? null
                          : form.state.values.economicEntityId
                      }
                      onPayeeSelected={(payee) =>
                        form.setFieldValue(
                          'payeeName',
                          payee?.displayName ?? form.state.values.payeeName
                        )
                      }
                      description='Trading partners (vendor/payee roles) rank first. Empty selection writes the name below alone.'
                    />
                  )}
                </form.Field>
                <form.AppField
                  name='payeeName'
                  children={(field) => (
                    <DocumentLineDropTarget
                      id='field:payeeName'
                      onDrop={(line) => field.handleChange(line.text)}
                    >
                      <field.TextField
                        label='Payee name'
                        placeholder='e.g. USPS'
                        description='Free text stays valid — a name-less receipt is a real expense. Drop a detected line here to fill it (pure UI — nothing is confirmed by a header-field drop).'
                      />
                    </DocumentLineDropTarget>
                  )}
                />
                <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
                  <form.AppField
                    name='expenseDate'
                    children={(field) => <field.TextField label='Date' required type='date' />}
                  />
                  <form.AppField
                    name='amount'
                    children={(field) => (
                      <DocumentLineDropTarget
                        id='field:amount'
                        onDrop={(line) => {
                          const extracted = extractProvisionalAmount(line.text);
                          if (extracted === null) {
                            toast.error('No amount found in that line — type it manually.');
                            return;
                          }
                          field.handleChange(extracted);
                        }}
                      >
                        <field.TextField
                          label='Amount'
                          required
                          inputMode='decimal'
                          placeholder='0.00'
                        />
                      </DocumentLineDropTarget>
                    )}
                  />
                </div>
                <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
                  <form.AppField
                    name='taxAmount'
                    children={(field) => (
                      <field.TextField label='Tax' inputMode='decimal' placeholder='0.00' />
                    )}
                  />
                  <form.AppField
                    name='category'
                    children={(field) => (
                      <DocumentLineDropTarget
                        id='field:category'
                        onDrop={(line) => field.handleChange(line.text)}
                      >
                        <div>
                          <field.TextField
                            label='Category'
                            required
                            list='new-expense-category-suggestions'
                            placeholder='e.g. shipping_supplies'
                            description='Your own vocabulary — an open set, not a fixed list.'
                          />
                          <datalist id='new-expense-category-suggestions'>
                            {SUGGESTED_EXPENSE_CATEGORIES.map((category) => (
                              <option key={category} value={category}>
                                {category}
                              </option>
                            ))}
                          </datalist>
                        </div>
                      </DocumentLineDropTarget>
                    )}
                  />
                </div>
                <div className='grid grid-cols-1 gap-6 sm:grid-cols-2'>
                  <form.AppField
                    name='paymentMethod'
                    children={(field) => (
                      <field.SelectField label='Payment' required options={paymentMethodOptions} />
                    )}
                  />
                  <form.AppField
                    name='currency'
                    children={(field) => (
                      <field.TextField label='Currency' required placeholder='USD' maxLength={3} />
                    )}
                  />
                </div>
                <form.AppField
                  name='economicEntityId'
                  children={(field) => (
                    <field.SelectField
                      label='Entity'
                      options={entityOptions}
                      description='Empty selection means Unattributed — a deliberate choice, not an omission.'
                    />
                  )}
                />
                <form.AppField
                  name='notes'
                  children={(field) => <field.TextareaField label='Notes' />}
                />
                <div className='flex flex-col gap-3 rounded-md border p-4'>
                  <div>
                    <p className='text-sm font-medium'>Line items</p>
                    <p className='text-muted-foreground text-xs'>
                      Optional — what was on the receipt, not where the money is charged. A
                      headline-only expense (no lines) stays valid.
                    </p>
                  </div>
                  <form.Field
                    name='lines'
                    mode='array'
                    children={(field) => (
                      <div className='flex flex-col gap-3'>
                        {field.state.value.map((_, index) => (
                          <div
                            key={index}
                            className='grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_5rem_6rem_6rem_auto]'
                          >
                            <form.Field
                              name={`lines[${index}].description`}
                              children={(subField) => (
                                <DocumentLineDropTarget
                                  id={`field:lines.${index}.description`}
                                  onDrop={(line) => subField.handleChange(line.text)}
                                >
                                  <Field>
                                    <Input
                                      placeholder='e.g. Shelving unit'
                                      value={subField.state.value}
                                      onChange={(event) =>
                                        subField.handleChange(event.target.value)
                                      }
                                      onBlur={subField.handleBlur}
                                      aria-label={`Line ${index + 1} description`}
                                    />
                                  </Field>
                                </DocumentLineDropTarget>
                              )}
                            />
                            <form.Field
                              name={`lines[${index}].quantity`}
                              children={(subField) => (
                                <Field>
                                  <Input
                                    inputMode='decimal'
                                    placeholder='qty'
                                    value={subField.state.value}
                                    onChange={(event) => subField.handleChange(event.target.value)}
                                    onBlur={subField.handleBlur}
                                    aria-label={`Line ${index + 1} quantity`}
                                  />
                                </Field>
                              )}
                            />
                            <form.Field
                              name={`lines[${index}].unitAmount`}
                              children={(subField) => (
                                <Field>
                                  <Input
                                    inputMode='decimal'
                                    placeholder='unit'
                                    value={subField.state.value}
                                    onChange={(event) => subField.handleChange(event.target.value)}
                                    onBlur={subField.handleBlur}
                                    aria-label={`Line ${index + 1} unit amount`}
                                  />
                                </Field>
                              )}
                            />
                            <form.Field
                              name={`lines[${index}].lineAmount`}
                              children={(subField) => {
                                const invalid =
                                  subField.state.meta.isTouched && !subField.state.meta.isValid;
                                return (
                                  <DocumentLineDropTarget
                                    id={`field:lines.${index}.lineAmount`}
                                    onDrop={(line) => {
                                      const extracted = extractProvisionalAmount(line.text);
                                      if (extracted === null) {
                                        toast.error(
                                          'No amount found in that line — type it manually.'
                                        );
                                        return;
                                      }
                                      subField.handleChange(extracted);
                                    }}
                                  >
                                    <Field data-invalid={invalid}>
                                      <Input
                                        inputMode='decimal'
                                        placeholder='0.00'
                                        value={subField.state.value}
                                        onChange={(event) =>
                                          subField.handleChange(event.target.value)
                                        }
                                        onBlur={subField.handleBlur}
                                        aria-label={`Line ${index + 1} amount`}
                                        aria-invalid={invalid}
                                      />
                                      {invalid && (
                                        <FieldError errors={subField.state.meta.errors} />
                                      )}
                                    </Field>
                                  </DocumentLineDropTarget>
                                );
                              }}
                            />
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              aria-label={`Remove line ${index + 1}`}
                              onClick={() => field.removeValue(index)}
                            >
                              <Icons.close />
                            </Button>
                          </div>
                        ))}
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          className='self-start'
                          onClick={() =>
                            field.pushValue({
                              description: '',
                              quantity: '',
                              unitAmount: '',
                              lineAmount: ''
                            })
                          }
                        >
                          <Icons.add />
                          Add line
                        </Button>
                      </div>
                    )}
                  />

                  {/*
                  loxep-cd3.5, M5: the SEPARATE "from a receipt" list — the
                  design's own "drag a line into LINES" target. A pinned line
                  is NOT a typed `lines[]` row (that array stays exactly what
                  the operator typed); it becomes its own `expense_lines` row
                  at save, carrying `document_line_candidate_id`, via
                  `createExpenseWithEvidence`'s `droppedLines`. Only its
                  amount is editable here — the description is the OCR'd
                  text, verbatim, per `document-preview.tsx`'s own doc.
                */}
                  <DocumentLineDropTarget
                    id='lines-list'
                    onDrop={addPinnedLine}
                    className='flex flex-col gap-2 border-t pt-3'
                    activeClassName='outline-primary bg-accent/40'
                  >
                    <p className='text-muted-foreground text-xs'>
                      Drag a detected receipt line here to add it as its own line item — or drop
                      anywhere in this box.
                    </p>
                    {pinnedLines.length === 0 ? (
                      <p className='text-muted-foreground rounded-md border border-dashed p-3 text-center text-xs'>
                        No receipt lines added yet
                      </p>
                    ) : (
                      <ul className='flex flex-col gap-2'>
                        {pinnedLines.map((pinned) => (
                          <li
                            key={pinned.candidateId}
                            className='grid grid-cols-1 items-center gap-2 rounded-md border p-2 sm:grid-cols-[1fr_7rem_auto]'
                          >
                            <span className='min-w-0 truncate text-sm' title={pinned.description}>
                              {pinned.description}
                            </span>
                            <Input
                              inputMode='decimal'
                              placeholder='0.00'
                              value={pinned.lineAmount}
                              onChange={(event) =>
                                setPinnedLines((prev) =>
                                  prev.map((line) =>
                                    line.candidateId === pinned.candidateId
                                      ? { ...line, lineAmount: event.target.value }
                                      : line
                                  )
                                )
                              }
                              aria-label={`Receipt line "${pinned.description}" amount`}
                            />
                            <Button
                              type='button'
                              variant='ghost'
                              size='icon'
                              aria-label={`Remove receipt line "${pinned.description}"`}
                              onClick={() =>
                                setPinnedLines((prev) =>
                                  prev.filter((line) => line.candidateId !== pinned.candidateId)
                                )
                              }
                            >
                              <Icons.close />
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </DocumentLineDropTarget>
                </div>
              </FieldGroup>
              <div className='flex justify-end gap-2'>
                <Button
                  type='button'
                  variant='outline'
                  disabled={mutation.isPending}
                  onClick={() => void form.handleSubmit({ status: 'draft' })}
                >
                  Save as draft
                </Button>
                <Button type='submit' disabled={mutation.isPending}>
                  Record expense
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <EvidencePane
          className={cn(activePane !== 'evidence' && 'hidden md:flex')}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          hoveredLineId={hoveredLineId}
          onHoveredLineChange={setHoveredLineId}
          renderLineActions={(line) => (
            <UseLineMenu
              line={line}
              onAddToLines={(l) =>
                addPinnedLine({
                  candidateId: l.id,
                  documentId: l.documentId,
                  lineNumber: l.lineNumber,
                  text: l.text
                })
              }
              onFillPayee={(text) => form.setFieldValue('payeeName', text)}
              onFillAmount={(text) => {
                const extracted = extractProvisionalAmount(text);
                if (extracted === null) {
                  toast.error('No amount found in that line — type it manually.');
                  return;
                }
                form.setFieldValue('amount', extracted);
              }}
              onFillCategory={(text) => form.setFieldValue('category', text)}
            />
          )}
        />
      </div>
    </DocumentLineDndProvider>
  );
}
