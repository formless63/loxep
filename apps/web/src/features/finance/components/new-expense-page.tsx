import * as React from 'react';
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldError, FieldGroup } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { InfoButton } from '@/components/ui/info-button';
import type { InfobarContent } from '@/components/ui/infobar';
import type { DocumentPreviewOverlayLine } from '@/components/document-preview';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useAppForm } from '@/lib/form';
import { createExpenseWithEvidence } from '@/server/expense-functions';
import { expenseQuery } from '@/features/finance/api/queries';
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
import { CategoryComboboxField } from '@/features/finance/components/category-combobox-field';
import {
  expenseLineKindOptions,
  expenseLineUnitOptions,
  NO_UNIT_VALUE,
  paymentMethodOptions,
  UNATTRIBUTED_ENTITY_VALUE
} from '@/features/finance/constants';
import {
  EMPTY_LINE_ITEM_DERIVE_STATE,
  setLineItemField,
  type LineItemDeriveKey,
  type LineItemDeriveState
} from '@/features/finance/lib/line-item-derive';

const DEFAULT_CURRENCY = 'USD';

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Mirrors `EXPENSE_LINE_KINDS` (`@loxep/accounting`/`packages/db/src/schema/expenses.ts`) — duplicated as a literal list matching this file's own `paymentMethod` precedent below. */
const LINE_KIND_VALUES = ['item', 'shipping', 'tax', 'fee', 'discount', 'other'] as const;
type LineKindValue = (typeof LINE_KIND_VALUES)[number];

/**
 * One row of the line-items editor v2 (loxep-zk5 — `expense-entry-design.md`
 * v2 status note, section 4). `lineAmount` is the only field the SERVER
 * requires, matching `expense_lines`' own schema; `quantity`/`unitAmount` are
 * informational, but on THIS page they are kept internally consistent by the
 * FILL-TWO-DERIVE-THIRD state machine (`@/features/finance/lib/line-item-derive.ts`)
 * rather than left to drift, because a receipt line usually gives the
 * operator two of the three and the third is arithmetic, not a second typing
 * task. Composed here, in the SAME form as the expense itself, because the
 * expense does not exist yet at compose time — the part-out dialog's
 * `children` array (`@/features/inventory/components/part-out-dialog.tsx`)
 * is the precedent for an in-form array of objects over a parallel
 * `useState` list.
 */
const lineItemSchema = z.object({
  description: z.string().trim(),
  quantity: z.string().trim(),
  unitAmount: z.string().trim(),
  lineAmount: z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d{1,6})?$/, 'Enter an amount, e.g. 12.50'),
  lineKind: z.enum(LINE_KIND_VALUES),
  /** {@link NO_UNIT_VALUE} (the select's own sentinel) or one of `EXPENSE_LINE_UNITS` — resolved to `null`/the value at submit. */
  unit: z.string().trim()
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
 * accepts an optional `payeeCounterpartyId` (mirroring `@/server/
 * expense-functions.ts`'s `createExpense`) — "both are written, always" per
 * the design, so once a picker exists here it needs no server change, only
 * a value to pass. As of this milestone no picker COMPONENT exists yet
 * under `apps/web/src` to mount (only `@/server/trading-partner-functions.ts`'s
 * server functions do), so this field stays a plain text input writing
 * `payeeName` only — free text alone stays valid per the design ("a
 * thrift-store receipt from a shop with no name is a real expense"). Swap
 * this `field.TextField` for the picker component when it lands, wiring its
 * resolved id into the `payeeCounterpartyId` the mutation already sends as
 * `null`; no other change on this page should be required.
 *
 * **Void-and-re-record (OWNER REVERSAL, 2026-08-17, `expense-entry-design.md`
 * decision 1):** `reRecordFrom`, when present, is a just-voided expense's id
 * — `expense-detail.tsx` navigates here with it right after the void write
 * lands. The source expense is loaded (via `expenseQuery`/`fetchExpense`,
 * prefetched by the route's own loader so it is already cache-warm here) and
 * seeds the form's fields only — never its evidence/receipts, matching the
 * old quick-dialog re-record prefill exactly (amount, category, payee name,
 * payment method, currency, entity; never the date, which still defaults to
 * today, and never a linked payee counterparty). A small banner names what
 * is happening; the void itself already happened before this page ever
 * mounts, and the voided row stays as evidence, unedited.
 */

// ---------------------------------------------------------------------------
// Density (loxep-zk5, D3): explanatory prose beyond one sentence moves behind
// an `InfoButton` rather than sitting inline as a field description — the
// page body states the one fact that matters, the info panel teaches the
// rest. These three replace what were previously two-sentence
// `field.TextField`/combobox `description` props.
// ---------------------------------------------------------------------------

const PAYEE_INFO: InfobarContent = {
  title: 'Payee',
  sections: [
    {
      title: 'Trading partner vs. free text',
      description:
        'Trading partners (vendor/payee roles) rank first in the picker. An empty selection writes the name field below alone — a thrift-store receipt from a shop with no name is still a real expense.'
    }
  ]
};

const PAYEE_NAME_INFO: InfobarContent = {
  title: 'Payee name',
  sections: [
    {
      title: 'Free text, and what a drop does',
      description:
        'Free text stays valid on its own. Dropping a detected receipt line here fills the field — that is pure UI convenience and confirms nothing in the database by itself.'
    }
  ]
};

const LINE_ITEMS_INFO: InfobarContent = {
  title: 'Line items',
  sections: [
    {
      title: 'Optional, and what it is not',
      description:
        'What was on the receipt, not where the money is charged — that split lives in allocations, a separate concept. A headline-only expense with no lines stays valid and complete.'
    }
  ]
};
export default function NewExpensePage({
  prefill,
  reRecordFrom
}: {
  prefill?: NewExpensePrefill;
  /** A just-voided expense's id — see this component's own doc for the re-record handoff. */
  reRecordFrom?: string;
}) {
  const { data: entities } = useSuspenseQuery(entitiesQuery);
  const { data: sourceExpense } = useQuery({
    ...expenseQuery(reRecordFrom ?? ''),
    enabled: reRecordFrom !== undefined
  });
  // Only the fields the old quick-dialog re-record prefill ever carried
  // (`QuickExpensePrefill`, now removed) — evidence/receipts are
  // deliberately NOT copied, and the entity's own null (Unattributed) is
  // preserved as the sentinel value rather than falling through to
  // `prefill`/the plain default below.
  const reRecordDefaults = sourceExpense
    ? {
        amount: sourceExpense.amount,
        category: sourceExpense.category,
        payeeName: sourceExpense.payeeName ?? '',
        paymentMethod: sourceExpense.paymentMethod as NewExpenseFormValues['paymentMethod'],
        currency: sourceExpense.currency,
        economicEntityId: sourceExpense.economicEntityId ?? UNATTRIBUTED_ENTITY_VALUE
      }
    : undefined;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [attachments, setAttachments] = React.useState<EvidenceAttachment[]>([]);
  const [pinnedLines, setPinnedLines] = React.useState<PinnedDocumentLine[]>([]);
  // FILL-TWO-DERIVE-THIRD ownership tracking for each typed `lines[]` row's
  // qty/unit-price/subtotal (loxep-zk5) — a parallel array kept in lockstep
  // with `form`'s own `lines` array by every push/remove below. The three
  // form fields (`quantity`/`unitAmount`/`lineAmount`) stay the values the
  // server receives; this array only tracks WHICH of the three is currently
  // computed, so the UI can mark it muted/italic and never clobber a value
  // the operator typed. See `line-item-derive.ts`'s own doc for the rules.
  const [lineDerive, setLineDerive] = React.useState<LineItemDeriveState[]>([]);
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
            lineAmount: line.lineAmount.trim(),
            lineKind: line.lineKind,
            // The select is UI-constrained to `EXPENSE_LINE_UNIT_VALUES` (or
            // the sentinel resolved to `null` below) — matches this
            // codebase's own `lineKind as never` precedent
            // (`expense-lines-card.tsx`) for a client-owned union crossing
            // into the server function's own narrower zod-inferred type.
            unit: (line.unit === NO_UNIT_VALUE || line.unit.trim() === ''
              ? null
              : line.unit) as never
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
      // Prefix-matches every finance query key (list, detail, reports).
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
      payeeName: reRecordDefaults?.payeeName ?? prefill?.payeeName ?? '',
      payeeCounterpartyId: NO_TRADING_PARTNER_VALUE,
      expenseDate: prefill?.expenseDate ?? todayIsoDate(),
      amount: reRecordDefaults?.amount ?? prefill?.amount ?? '',
      taxAmount: '',
      category: reRecordDefaults?.category ?? prefill?.category ?? '',
      paymentMethod:
        reRecordDefaults?.paymentMethod ??
        (prefill?.paymentMethod as NewExpenseFormValues['paymentMethod']) ??
        'card',
      currency: reRecordDefaults?.currency ?? prefill?.currency ?? DEFAULT_CURRENCY,
      economicEntityId:
        reRecordDefaults?.economicEntityId ??
        prefill?.economicEntityId ??
        UNATTRIBUTED_ENTITY_VALUE,
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

  const LINE_DERIVE_FORM_FIELD: Record<
    LineItemDeriveKey,
    'quantity' | 'unitAmount' | 'lineAmount'
  > = {
    quantity: 'quantity',
    unitPrice: 'unitAmount',
    subtotal: 'lineAmount'
  };

  /**
   * One qty/unit-price/subtotal field on line `index` was edited (including
   * cleared to `''`) — routes the raw input through the pure state machine
   * (`setLineItemField`) and mirrors ALL THREE of that row's numeric fields
   * back into the form, so the derived field (if any) stays visible and
   * `lineAmount` — the one number the server trusts — is always the current
   * value the state machine computed, never a stale one.
   */
  function updateLineNumberField(index: number, key: LineItemDeriveKey, rawValue: string) {
    const current = lineDerive[index] ?? EMPTY_LINE_ITEM_DERIVE_STATE;
    const next = setLineItemField(current, key, rawValue);
    setLineDerive((prev) => {
      const copy = [...prev];
      copy[index] = next;
      return copy;
    });
    (['quantity', 'unitPrice', 'subtotal'] as const).forEach((k) => {
      form.setFieldValue(`lines[${index}].${LINE_DERIVE_FORM_FIELD[k]}`, next[k].value);
    });
  }

  return (
    <div className='flex flex-col gap-4'>
      {reRecordFrom && sourceExpense && (
        <Alert>
          <Icons.info />
          <AlertTitle>Re-recording {sourceExpense.referenceCode}</AlertTitle>
          <AlertDescription>
            The original stays void, kept as evidence — this records the corrected fact as a new
            expense.
          </AlertDescription>
        </Alert>
      )}
      <DocumentLineDndProvider>
        {/*
          loxep-zk5, layout inversion: the evidence/PDF preview is now the
          DOMINANT flexible pane; the form is a fixed compact column at
          desktop widths — the owner's own words are "kill the form's white
          space" and "evidence becomes the dominant pane." `28rem` reads well
          against the density-tightened field grid below (`gap-3`, compact
          inputs); the row's DOM order is unchanged (form first, evidence
          second) — only the two column WIDTHS invert versus the prior
          `minmax(0,1fr)_360px`.
        */}
        <div className='grid grid-cols-1 gap-4 md:grid-cols-[28rem_minmax(0,1fr)] md:items-start'>
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
            <CardContent>
              <form
                className='space-y-4'
                onSubmit={(event) => {
                  event.preventDefault();
                  void form.handleSubmit({ status: 'recorded' });
                }}
              >
                <FieldGroup>
                  <div className='flex items-end gap-1'>
                    <div className='flex-1'>
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
                          />
                        )}
                      </form.Field>
                    </div>
                    <InfoButton content={PAYEE_INFO} className='mb-1 size-7' />
                  </div>
                  <div className='flex items-end gap-1'>
                    <div className='flex-1'>
                      <form.AppField
                        name='payeeName'
                        children={(field) => (
                          <DocumentLineDropTarget
                            id='field:payeeName'
                            onDrop={(line) => field.handleChange(line.text)}
                          >
                            <field.TextField label='Payee name' placeholder='e.g. USPS' />
                          </DocumentLineDropTarget>
                        )}
                      />
                    </div>
                    <InfoButton content={PAYEE_NAME_INFO} className='mb-1 size-7' />
                  </div>
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
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
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <form.AppField
                      name='taxAmount'
                      children={(field) => (
                        <field.TextField label='Tax' inputMode='decimal' placeholder='0.00' />
                      )}
                    />
                    <form.Field name='category'>
                      {(field) => (
                        <DocumentLineDropTarget
                          id='field:category'
                          onDrop={(line) => field.handleChange(line.text)}
                        >
                          <CategoryComboboxField
                            label='Category'
                            name='category'
                            required
                            value={field.state.value}
                            onChange={field.handleChange}
                            onBlur={field.handleBlur}
                            invalid={field.state.meta.isTouched && !field.state.meta.isValid}
                            errors={field.state.meta.errors}
                          />
                        </DocumentLineDropTarget>
                      )}
                    </form.Field>
                  </div>
                  <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
                    <form.AppField
                      name='paymentMethod'
                      children={(field) => (
                        <field.SelectField
                          label='Payment'
                          required
                          options={paymentMethodOptions}
                        />
                      )}
                    />
                    <form.AppField
                      name='currency'
                      children={(field) => (
                        <field.TextField
                          label='Currency'
                          required
                          placeholder='USD'
                          maxLength={3}
                        />
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
                  <div className='flex flex-col gap-3 rounded-md border p-3'>
                    <div className='flex items-center justify-between'>
                      <p className='text-sm font-medium'>Line items — optional</p>
                      <InfoButton content={LINE_ITEMS_INFO} className='size-6' />
                    </div>
                    <form.Field
                      name='lines'
                      mode='array'
                      children={(field) => (
                        <div className='flex flex-col gap-3'>
                          {field.state.value.length > 0 && (
                            <div className='text-muted-foreground grid grid-cols-4 gap-1.5 px-0.5 text-[0.65rem] uppercase'>
                              <span>Qty</span>
                              <span>Unit</span>
                              <span>Unit price</span>
                              <span>Subtotal</span>
                            </div>
                          )}
                          {field.state.value.map((_, index) => {
                            const rowDerive = lineDerive[index] ?? EMPTY_LINE_ITEM_DERIVE_STATE;
                            return (
                              <div
                                key={index}
                                className='flex flex-col gap-1.5 rounded-md border p-2'
                              >
                                <div className='flex items-end gap-1.5'>
                                  <form.Field
                                    name={`lines[${index}].lineKind`}
                                    children={(subField) => (
                                      <Select
                                        value={subField.state.value}
                                        onValueChange={(next) =>
                                          subField.handleChange(next as LineKindValue)
                                        }
                                      >
                                        <SelectTrigger
                                          className='w-28 shrink-0'
                                          aria-label={`Line ${index + 1} kind`}
                                        >
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {expenseLineKindOptions.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                              {option.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    )}
                                  />
                                  <form.Field
                                    name={`lines[${index}].description`}
                                    children={(subField) => (
                                      <DocumentLineDropTarget
                                        id={`field:lines.${index}.description`}
                                        onDrop={(line) => subField.handleChange(line.text)}
                                        className='flex-1'
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
                                  <Button
                                    type='button'
                                    variant='ghost'
                                    size='icon'
                                    className='shrink-0'
                                    aria-label={`Remove line ${index + 1}`}
                                    onClick={() => {
                                      field.removeValue(index);
                                      setLineDerive((prev) => prev.filter((_, i) => i !== index));
                                    }}
                                  >
                                    <Icons.close />
                                  </Button>
                                </div>
                                <div className='grid grid-cols-4 items-start gap-1.5'>
                                  <Field>
                                    <Input
                                      inputMode='decimal'
                                      placeholder='0'
                                      value={rowDerive.quantity.value}
                                      onChange={(event) =>
                                        updateLineNumberField(index, 'quantity', event.target.value)
                                      }
                                      aria-label={`Line ${index + 1} quantity`}
                                      title={
                                        rowDerive.quantity.owner === 'derived'
                                          ? 'Derived from unit price and subtotal — edit to override'
                                          : undefined
                                      }
                                      className={cn(
                                        rowDerive.quantity.owner === 'derived' &&
                                          'text-muted-foreground italic'
                                      )}
                                    />
                                  </Field>
                                  <form.Field
                                    name={`lines[${index}].unit`}
                                    children={(subField) => (
                                      <Select
                                        value={subField.state.value || NO_UNIT_VALUE}
                                        onValueChange={(next) => subField.handleChange(next)}
                                      >
                                        <SelectTrigger aria-label={`Line ${index + 1} unit`}>
                                          <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                          {expenseLineUnitOptions.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                              {option.label}
                                            </SelectItem>
                                          ))}
                                        </SelectContent>
                                      </Select>
                                    )}
                                  />
                                  <Field>
                                    <Input
                                      inputMode='decimal'
                                      placeholder='0.00'
                                      value={rowDerive.unitPrice.value}
                                      onChange={(event) =>
                                        updateLineNumberField(
                                          index,
                                          'unitPrice',
                                          event.target.value
                                        )
                                      }
                                      aria-label={`Line ${index + 1} unit price`}
                                      title={
                                        rowDerive.unitPrice.owner === 'derived'
                                          ? 'Derived from quantity and subtotal — edit to override'
                                          : undefined
                                      }
                                      className={cn(
                                        rowDerive.unitPrice.owner === 'derived' &&
                                          'text-muted-foreground italic'
                                      )}
                                    />
                                  </Field>
                                  <form.Field
                                    name={`lines[${index}].lineAmount`}
                                    children={(subField) => {
                                      const invalid =
                                        subField.state.meta.isTouched &&
                                        !subField.state.meta.isValid;
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
                                            updateLineNumberField(index, 'subtotal', extracted);
                                          }}
                                        >
                                          <Field data-invalid={invalid}>
                                            <Input
                                              inputMode='decimal'
                                              placeholder='0.00'
                                              value={rowDerive.subtotal.value}
                                              onChange={(event) =>
                                                updateLineNumberField(
                                                  index,
                                                  'subtotal',
                                                  event.target.value
                                                )
                                              }
                                              onBlur={subField.handleBlur}
                                              aria-label={`Line ${index + 1} subtotal`}
                                              aria-invalid={invalid}
                                              title={
                                                rowDerive.subtotal.owner === 'derived'
                                                  ? 'Derived from quantity and unit price — edit to override'
                                                  : undefined
                                              }
                                              className={cn(
                                                rowDerive.subtotal.owner === 'derived' &&
                                                  'text-muted-foreground italic'
                                              )}
                                            />
                                            {invalid && (
                                              <FieldError errors={subField.state.meta.errors} />
                                            )}
                                          </Field>
                                        </DocumentLineDropTarget>
                                      );
                                    }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                          <Button
                            type='button'
                            variant='outline'
                            size='sm'
                            className='self-start'
                            onClick={() => {
                              field.pushValue({
                                description: '',
                                quantity: '',
                                unitAmount: '',
                                lineAmount: '',
                                lineKind: 'item',
                                unit: NO_UNIT_VALUE
                              });
                              setLineDerive((prev) => [...prev, EMPTY_LINE_ITEM_DERIVE_STATE]);
                            }}
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
    </div>
  );
}
