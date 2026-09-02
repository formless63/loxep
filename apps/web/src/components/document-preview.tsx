import * as React from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * One recognized line of a document's overlay (loxep-cd3.5, M5 —
 * `expense-entry-design.md` section 3's tier B). `region` is in the SOURCE
 * IMAGE's own pixel space — exactly what `document_line_candidates.source_region`
 * stores (`@loxep/documents`'s `source-region.ts`) — never a screen
 * coordinate; see this component's own doc below for how a responsive
 * render is reconciled with a fixed-pixel box.
 */
export interface DocumentPreviewOverlayLine {
  /** The `document_line_candidates.id` this box came from. */
  id: string;
  /** The candidate's own `documents.id` — carried through the drag payload so a multi-document caller (the evidence pane, several attachments) can group a drop by document without a second lookup. */
  documentId: string;
  lineNumber: number;
  /** The OCR'd text, verbatim — never edited by this component. */
  text: string;
  region: { x: number; y: number; w: number; h: number };
}

export interface DocumentPreviewOverlay {
  lines: DocumentPreviewOverlayLine[];
  hoveredId?: string | null;
  onHoverChange?: (id: string | null) => void;
  /**
   * When true, every box becomes an `@dnd-kit/core` `useDraggable` — the
   * sanctioned drag library (`expense-entry-design.md`'s own DND rule; no
   * raw `DragEvent`/`dataTransfer` handling anywhere in this codebase).
   * Requires this component to be rendered under an ancestor `<DndContext>`;
   * omit (or pass `false`) for a highlight-only mount (`document-review-panel.tsx`'s
   * mode, which has no drop target of its own).
   */
  draggable?: boolean;
  /**
   * The keyboard/click equivalent — required by the design's own
   * accessibility rule ("drag is not the only path... a drag-only
   * affordance is unusable with a keyboard"). Rendered per line in the
   * "Detected lines" list this component shows below the image, which is a
   * real, always-present, Tab-reachable list regardless of `draggable`.
   */
  renderActions?: (line: DocumentPreviewOverlayLine) => React.ReactNode;
}

function OverlayBox({
  line,
  naturalWidth,
  naturalHeight,
  hovered,
  draggable,
  onHoverChange
}: {
  line: DocumentPreviewOverlayLine;
  naturalWidth: number;
  naturalHeight: number;
  hovered: boolean;
  draggable: boolean;
  onHoverChange?: (id: string | null) => void;
}) {
  // dnd-kit's `useDraggable` must run unconditionally per the rules of
  // hooks, so it is always called — `draggable` only gates whether its
  // listeners/attributes are actually spread onto the element below. When
  // this component is not under a DndContext (the non-draggable mode),
  // dnd-kit tolerates the call (its context falls back to an internal
  // default) as long as the returned handlers are never wired up.
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `doc-line:${line.id}`,
    data: { type: 'document-line' as const, line }
  });

  // Boxes are positioned as PERCENTAGES of the image's own natural size —
  // the img element renders at `w-full h-auto` (no letterboxing, unlike
  // `object-fit: contain`), so its rendered box scales uniformly with the
  // natural size and a percentage IS the source-pixel-to-rendered-pixel
  // ratio; no pixel math or resize listener is needed for this to stay
  // correct across every viewport width.
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${(line.region.x / naturalWidth) * 100}%`,
    top: `${(line.region.y / naturalHeight) * 100}%`,
    width: `${(line.region.w / naturalWidth) * 100}%`,
    height: `${(line.region.h / naturalHeight) * 100}%`,
    transform: draggable ? CSS.Translate.toString(transform) : undefined
  };

  return (
    <div
      ref={draggable ? setNodeRef : undefined}
      style={style}
      className={cn(
        'border-primary/60 bg-primary/10 rounded-[2px] border transition-colors',
        (hovered || isDragging) && 'border-primary bg-primary/25',
        draggable && 'cursor-grab touch-none active:cursor-grabbing'
      )}
      onMouseEnter={() => onHoverChange?.(line.id)}
      onMouseLeave={() => onHoverChange?.(null)}
      aria-hidden='true'
      // No accessible name (it is `aria-hidden` — the "Detected lines" list
      // below is the accessible/keyboard path to the same line); a
      // `data-testid` is this repo's own precedent for exactly this case
      // (`connections-table/columns.tsx`'s `SyncSummaryCell`).
      data-testid='document-line-box'
      data-candidate-id={line.id}
      {...(draggable ? { ...attributes, ...listeners } : {})}
    />
  );
}

/**
 * The one shared preview surface for a stored document/receipt (loxep-cd3.2,
 * M2 — `expense-entry-design.md`, "Previews: what a no-external-CDN app can
 * actually render"). Built BEFORE either consumer uses it, per the design's
 * own "before implementing" rule 5, and used by BOTH
 * `apps/web/src/features/documents/components/document-review-panel.tsx`
 * (which rendered every document with a bare `<img>` and was therefore
 * already broken for PDFs) and the `/finance/expenses/new` evidence pane, so
 * the PDF case is fixed once rather than drifting between two components.
 *
 * The tier-1 answer, stated honestly rather than wished for:
 *
 * - `image/*` — a plain `<img>`, object-fit contain. Zero cost, ships now.
 *   **Except when `overlay` is given** (loxep-cd3.5, M5): the image instead
 *   renders `w-full h-auto` (full natural aspect ratio, no letterboxing) so
 *   `<OverlayBox>` above can position every `document_line_candidates.source_region`
 *   box as a simple percentage of natural size — see that component's own
 *   doc for why no pixel-ratio math is needed.
 * - `application/pdf` — a fully sandboxed `<iframe>` over the SAME
 *   `servingUrl`, i.e. the browser's own PDF viewer: same-origin,
 *   session-cookie gated (every serving route already sits behind
 *   `requireSession`), zero bundle cost, zero new dependency. Chromium may
 *   refuse to render its native viewer inside a sandbox, so explicit open
 *   and download links remain available below it. The other caveat is real
 *   and stated on the surface rather than discovered: the operator gets the
 *   browser's chrome, not Loxep's, and a highlight box cannot be drawn over
 *   a browser-native PDF viewer. **`overlay` is a no-op for a PDF document**
 *   — the design scopes tier B's PDF answer to a `pdfjs-dist`-controlled canvas
 *   (`expense-entry-design.md`, M5's own "WHAT" section), which needs a new
 *   dependency this pass's write fence does not authorize
 *   (`apps/web/package.json` is out of scope). Recorded as an explicit gap
 *   rather than a silent omission — see the design doc's M5 status note.
 * - anything else, or no `servingUrl` at all (an object whose purpose has no
 *   serving route — see `@/server/media-serving-url.ts`) — a generic file
 *   icon and an honest "no preview" message, never a broken-image icon.
 *
 * REJECTED per the design: a server-rendered first-page PDF thumbnail
 * (poppler/mupdf in the image for every deployment, including the ones that
 * never attach a PDF) — see the design doc for the full reasoning.
 *
 * ## The overlay's own scope (loxep-cd3.5, M5)
 *
 * Line-level boxes ONLY — every box comes from a `document_line_candidates.source_region`,
 * never a word-level or header-field region (the design declined to invent
 * storage for those; see its "SCOPE, honestly bounded" list). This
 * component never writes anything; it is pure presentation plus a drag
 * SOURCE, and the caller decides what a drop or a click means.
 */
export function DocumentPreview({
  mimeType,
  servingUrl,
  alt,
  className,
  overlay
}: {
  mimeType: string | null;
  servingUrl: string | null;
  /** Accessible name for the image/iframe — typically the original filename. */
  alt: string;
  className?: string;
  overlay?: DocumentPreviewOverlay;
}) {
  const [naturalSize, setNaturalSize] = React.useState<{ width: number; height: number } | null>(
    null
  );

  if (servingUrl === null) {
    return (
      <div
        className={cn(
          'bg-muted/25 text-muted-foreground flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center text-sm',
          className
        )}
      >
        <Icons.page className='size-8' aria-hidden='true' />
        <span>No preview available</span>
      </div>
    );
  }

  if (mimeType !== null && mimeType.startsWith('image/')) {
    const isOverlay = overlay !== undefined && overlay.lines.length > 0;
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <div className='relative'>
          <img
            src={servingUrl}
            alt={alt}
            className={cn(
              'rounded-md border',
              isOverlay ? 'h-auto w-full' : 'h-full w-full object-contain'
            )}
            onLoad={(event) => {
              const target = event.currentTarget;
              setNaturalSize({ width: target.naturalWidth, height: target.naturalHeight });
            }}
          />
          {isOverlay &&
            naturalSize !== null &&
            overlay.lines.map((line) => (
              <OverlayBox
                key={line.id}
                line={line}
                naturalWidth={naturalSize.width}
                naturalHeight={naturalSize.height}
                hovered={overlay.hoveredId === line.id}
                draggable={overlay.draggable === true}
                onHoverChange={overlay.onHoverChange}
              />
            ))}
        </div>
        {isOverlay && (
          <div className='max-h-40 space-y-1 overflow-y-auto rounded-md border p-2'>
            <p className='text-muted-foreground text-xs font-medium'>
              Detected lines — drag a line, or use the keyboard equivalent below
            </p>
            <ul className='space-y-1'>
              {overlay.lines.map((line) => (
                <DetectedLineRow
                  key={line.id}
                  line={line}
                  hovered={overlay.hoveredId === line.id}
                  onHoverChange={overlay.onHoverChange}
                  actions={overlay.renderActions?.(line)}
                />
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  if (mimeType === 'application/pdf') {
    return (
      <div className={cn('flex h-full min-h-0 w-full flex-col gap-1', className)}>
        <iframe
          src={servingUrl}
          title={alt}
          // Uploaded documents are untrusted content. Grant no sandbox
          // capabilities here; a same-origin exception would let an active
          // response share Loxep's origin. Chromium's native PDF viewer may
          // decline this sandbox, which is why the explicit open/download
          // fallback below is part of the component rather than an error UI.
          sandbox=''
          className='min-h-0 w-full flex-1 rounded-md border'
        />
        <div className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
          <span>
            Sandboxed browser PDF viewer — some browsers block inline viewing, and detected-line
            highlights apply to image receipts only.
          </span>
          <a
            href={servingUrl}
            target='_blank'
            rel='noreferrer'
            className='text-primary font-medium hover:underline'
          >
            Open PDF in a new tab
          </a>
          <a href={servingUrl} download={alt} className='text-primary font-medium hover:underline'>
            Download PDF
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'bg-muted/25 text-muted-foreground flex h-full min-h-40 w-full flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center text-sm',
        className
      )}
    >
      <Icons.page className='size-8' aria-hidden='true' />
      <span>Preview not available for this file type</span>
      <a
        href={servingUrl}
        target='_blank'
        rel='noreferrer'
        className='text-primary hover:underline'
      >
        Open the file
      </a>
    </div>
  );
}

/**
 * A single row of the always-present, always-keyboard-reachable "Detected
 * lines" list — the accessibility floor the design requires ("every
 * draggable line has a keyboard/click equivalent"). The drag SOURCE is the
 * highlight box over the image (`<OverlayBox>`, one `useDraggable` per
 * line); this row is deliberately NOT a second draggable for the same line
 * (dnd-kit requires unique draggable ids, and two drag handles for one line
 * would be a confusing surface, not a more accessible one) — it supplies
 * the text, the hover sync, and `actions`, whatever the caller renders
 * (typically a small menu of "use this line for..." choices) as the
 * keyboard/click equivalent instead.
 */
function DetectedLineRow({
  line,
  hovered,
  onHoverChange,
  actions
}: {
  line: DocumentPreviewOverlayLine;
  hovered: boolean;
  onHoverChange?: (id: string | null) => void;
  actions?: React.ReactNode;
}) {
  return (
    // Pointer-only hover sync with the overlay box sharing this line's id —
    // `actions` (a real interactive element, e.g. a menu button) is this
    // row's keyboard-reachable equivalent, so no key handler belongs here.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      className={cn(
        'flex items-center gap-2 rounded-md border px-2 py-1 text-sm',
        hovered && 'border-primary bg-accent'
      )}
      onMouseEnter={() => onHoverChange?.(line.id)}
      onMouseLeave={() => onHoverChange?.(null)}
    >
      <span className='min-w-0 flex-1 truncate' title={line.text}>
        {line.text}
      </span>
      {actions}
    </li>
  );
}
