import * as React from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core';
import type { DocumentPreviewOverlayLine } from '@/components/document-preview';
import { cn } from '@/lib/utils';

/**
 * The drag payload every `document-line` draggable in `/finance` carries
 * (`document-preview.tsx`'s `useDraggable` boxes) — `documentId` travels
 * alongside so a drop handler can group dragged lines by document without a
 * second lookup, matching `confirmCandidatesAsExpense`'s own one-document-
 * per-call shape (`packages/accounting/src/confirm.ts`).
 */
export interface DraggedDocumentLine {
  candidateId: string;
  documentId: string;
  lineNumber: number;
  text: string;
}

/**
 * `expense-entry-design.md` section 4's "the weave": dragging into a FIELD
 * is pure UI (never a database write), so an amount field needs SOME
 * interpretation of a raw OCR'd line's text — this milestone's own
 * provisional rule, since tier B stops at boxes and raw text and refuses to
 * guess a structured amount at parse time (that would be tier C, refused).
 * **PROVISIONAL, stated because the design does not specify one**: the
 * RIGHTMOST decimal token in the line, e.g. `"TAPE 2 @ 3.99 7.98"` ->
 * `"7.98"` — a receipt line's trailing number is its extended/total price
 * far more often than its unit price or its quantity. Returns `null` when
 * no decimal token is found; the caller decides how to surface that (an
 * empty field the operator fills by hand, never a guessed zero).
 */
export function extractProvisionalAmount(text: string): string | null {
  const matches = text.match(/-?\d+\.\d{1,2}/g);
  if (matches === null || matches.length === 0) return null;
  return matches[matches.length - 1] ?? null;
}

/**
 * One drop target: a form field, a line-item subfield, or the "add to line
 * items" zone. `onDrop` is stored as this droppable's OWN `data` — the
 * `DndContext`'s single `onDragEnd` below reads it back off `over.data`
 * rather than branching on `over.id`, so each target owns its own
 * interpretation of the dragged line (a plain field just takes the text; an
 * amount field runs {@link extractProvisionalAmount} first) without a
 * growing switch statement anywhere else.
 */
export function DocumentLineDropTarget({
  id,
  onDrop,
  className,
  activeClassName,
  children
}: {
  id: string;
  onDrop: (line: DraggedDocumentLine) => void;
  className?: string;
  activeClassName?: string;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id, data: { onDrop } });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        className,
        'rounded-md outline-2 outline-offset-2 outline-transparent transition-[outline-color]',
        isOver && (activeClassName ?? 'outline-primary')
      )}
    >
      {children}
    </div>
  );
}

/**
 * The page-level DnD context (loxep-cd3.5, M5). `@dnd-kit/core` per
 * `expense-entry-design.md`'s own DND rule — never a second drag library,
 * never a hand-rolled `DragEvent`/`dataTransfer` handler. `PointerSensor`
 * (mouse/touch) plus `KeyboardSensor` are both registered so dnd-kit's own
 * keyboard-drag path exists as a fallback, though this milestone's PRIMARY
 * keyboard/click equivalent is the explicit "Use this line for…" menu each
 * consumer wires through `DocumentPreviewOverlay.renderActions` — see that
 * component's doc.
 *
 * `onDragEnd` is deliberately generic: it reads the dragged line off
 * `active.data.current.line` and the drop handler off
 * `over.data.current.onDrop`, and calls one with the other. No consumer of
 * this provider should need a second `onDragEnd` — a new drop TARGET is
 * just a new `<DocumentLineDropTarget onDrop={...}>`, not a new branch here.
 */
function toDraggedLine(line: DocumentPreviewOverlayLine): DraggedDocumentLine {
  return {
    candidateId: line.id,
    documentId: line.documentId,
    lineNumber: line.lineNumber,
    text: line.text
  };
}

export function DocumentLineDndProvider({ children }: { children: React.ReactNode }) {
  const [activeLine, setActiveLine] = React.useState<DraggedDocumentLine | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );

  function handleDragStart(event: DragStartEvent) {
    const line = (event.active.data.current as { line?: DocumentPreviewOverlayLine } | undefined)
      ?.line;
    if (line !== undefined) setActiveLine(toDraggedLine(line));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveLine(null);
    const { active, over } = event;
    if (!over) return;
    const line = (active.data.current as { line?: DocumentPreviewOverlayLine } | undefined)?.line;
    const onDrop = (
      over.data.current as { onDrop?: (line: DraggedDocumentLine) => void } | undefined
    )?.onDrop;
    if (line === undefined || onDrop === undefined) return;
    onDrop(toDraggedLine(line));
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveLine(null)}
    >
      {children}
      <DragOverlay>
        {activeLine && (
          <div className='bg-popover text-popover-foreground max-w-64 truncate rounded-md border px-2 py-1 text-sm shadow-lg'>
            {activeLine.text}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
