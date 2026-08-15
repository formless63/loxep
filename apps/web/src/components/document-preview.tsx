import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

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
 * - `application/pdf` — an `<iframe>` over the SAME `servingUrl`, i.e. the
 *   browser's own PDF viewer: same-origin, session-cookie gated (every
 *   serving route already sits behind `requireSession`), zero bundle cost,
 *   zero new dependency. The caveat is real and stated on the surface below
 *   rather than discovered: the operator gets the browser's chrome, not
 *   Loxep's, and a highlight box cannot be drawn over a browser-native PDF
 *   viewer — which is exactly why tier B (drag-to-field, M5) needs
 *   `pdfjs-dist` and this component does not.
 * - anything else, or no `servingUrl` at all (an object whose purpose has no
 *   serving route — see `@/server/media-serving-url.ts`) — a generic file
 *   icon and an honest "no preview" message, never a broken-image icon.
 *
 * REJECTED per the design: a server-rendered first-page PDF thumbnail
 * (poppler/mupdf in the image for every deployment, including the ones that
 * never attach a PDF) — see the design doc for the full reasoning.
 */
export function DocumentPreview({
  mimeType,
  servingUrl,
  alt,
  className
}: {
  mimeType: string | null;
  servingUrl: string | null;
  /** Accessible name for the image/iframe — typically the original filename. */
  alt: string;
  className?: string;
}) {
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
    return (
      <img
        src={servingUrl}
        alt={alt}
        className={cn('h-full w-full rounded-md border object-contain', className)}
      />
    );
  }

  if (mimeType === 'application/pdf') {
    return (
      <div className={cn('flex h-full min-h-80 w-full flex-col gap-1', className)}>
        <iframe
          src={servingUrl}
          title={alt}
          // Same-origin, session-cookie-gated bytes we serve ourselves (see
          // this component's own doc) — `allow-same-origin` keeps the
          // browser's native PDF viewer working; `allow-downloads` keeps its
          // built-in download/print affordance usable. No script/form/
          // top-navigation permission is granted.
          sandbox='allow-same-origin allow-downloads'
          className='h-full min-h-80 w-full rounded-md border'
        />
        <p className='text-muted-foreground text-xs'>
          Shown in your browser's own PDF viewer — no highlight overlay is possible here (that
          arrives with tier B's drag-to-field pass).
        </p>
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
