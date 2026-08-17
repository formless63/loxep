export interface StackedStatusBarSegment {
  key: string;
  label: string;
  count: number;
  /** A CSS color value — callers pass a theme token (`var(--success)`, `var(--chart-2)`, …), never a literal. */
  color: string;
}

/**
 * The bar's actual logic, pulled out so it's unit-testable without
 * rendering (this repo's test suite tests pure helpers, not component
 * output — see `market-functions.test.ts`'s `shapePriceTrends` for the same
 * split). `null` means "render nothing" (a zero total); otherwise the
 * zero-count segments are dropped, since a 0-wide flex-basis segment draws
 * nothing but still costs a DOM node.
 */
export function visibleStatusBarSegments(
  segments: readonly StackedStatusBarSegment[]
): StackedStatusBarSegment[] | null {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;
  return segments.filter((segment) => segment.count > 0);
}

/**
 * A single horizontal bar split into segments proportional to each status's
 * count — the compact "distribution at a glance" companion to a status
 * badge row (the badges stay beneath it as the legend, per
 * `/inventory/overview` and `/commerce/overview`'s "Stock by status"/
 * "Listings by status" cards, loxep-0g4 D4). Pure presentation over
 * already-fetched counts — this renders nothing that costs a query.
 *
 * A zero total renders nothing (`null`), never an empty/invisible bar; the
 * caller's own empty/loading treatment above this component already covers
 * that case.
 */
export function StackedStatusBar({ segments }: { segments: StackedStatusBarSegment[] }) {
  const nonEmpty = visibleStatusBarSegments(segments);
  if (nonEmpty === null) return null;

  return (
    <div
      className='bg-muted flex h-3 w-full overflow-hidden rounded-full'
      role='img'
      aria-label={nonEmpty.map((segment) => `${segment.label}: ${segment.count}`).join(', ')}
    >
      {nonEmpty.map((segment) => (
        <div
          key={segment.key}
          className='h-full'
          style={{ flexGrow: segment.count, backgroundColor: segment.color }}
          title={`${segment.label}: ${segment.count}`}
        />
      ))}
    </div>
  );
}
