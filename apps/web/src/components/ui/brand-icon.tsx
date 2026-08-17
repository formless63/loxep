import type { Icon } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * `BrandIcon` (loxep-2xk, ui-overhaul-2026-design.md §5, rules I1-I4) — the
 * one component that renders a provider's identity mark anywhere in Loxep.
 * `simple-icons` icon data becomes an inline `<svg>`; nothing here ever
 * fetches from a CDN or points an `<img>` at a brand's own site (rule I1).
 *
 * Fallback chain (rule I1): a `simple-icons` mark, else the caller-supplied
 * `fallback` icon component (the semantic icon `PROVIDER_BRAND_ICON_
 * FALLBACKS`, `@/config/provider-brand-icons`, carries for a provider with no
 * mark), else an initial-letter tile on `bg-muted`.
 *
 * Rule I2 — monochrome `currentColor` everywhere: the mark's `fill` and the
 * fallback icon both inherit the surrounding text color; no brand hex ever
 * reaches this component (`PROVIDER_BRAND_ICONS` stores only `{ path }`, not
 * `hex`). The one permitted flourish — the integrations catalog card's
 * `bg-primary/10` tile — is the CALLER's wrapper, not something this
 * component does itself, so every other surface stays plain by construction.
 *
 * Rule I4 — sizes 16/20/24px only, enforced by `BrandIconSize`'s literal
 * union rather than a general `number`.
 *
 * Accessibility: `BrandIcon` is decorative (`aria-hidden`) by default,
 * because every shipped surface (I4's six) places it directly beside the
 * provider's name in text — the name is already announced once. Pass `label`
 * only for a standalone icon with no adjacent text (none of today's six
 * surfaces need it, but a future one might); it flips the mark to
 * `role="img"` with that accessible name instead of hiding it.
 */

/** Sizes rule I4 permits — no others. */
export type BrandIconSize = 16 | 20 | 24;

/** The subset of a `simple-icons` icon object `BrandIcon` actually renders — never `hex` (rule I2: brand color never reaches this component). */
export interface BrandMark {
  readonly path: string;
}

export interface BrandIconProps {
  /**
   * A `simple-icons` icon object (e.g. the `siCloudflare` named export), or
   * `null` when `PROVIDER_BRAND_ICONS` has no mark for this provider —
   * never `undefined`, so a registry gap is a type error, not a silent
   * fallback.
   */
  mark: BrandMark | null;
  /**
   * The registry's fallback icon component, rendered when `mark` is `null`.
   * Omitted entirely (not just `undefined`-valued) skips straight to the
   * initial-letter tile — used for a provider with neither a mark nor a
   * documented fallback icon.
   */
  fallback?: Icon;
  /** The provider's display name — source of the initial-letter tile's letter and, with `label` omitted, this icon stays purely decorative. */
  name: string;
  /** Sizes rule I4 permits — no others. */
  size: BrandIconSize;
  /** Exposes an accessible name for a standalone icon with no adjacent text label. Omit when the icon sits beside the provider's name in text (every shipped surface today) — the mark stays `aria-hidden` and the adjacent text already carries the name. */
  label?: string;
  className?: string;
}

function initialLetter(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : '?';
}

export function BrandIcon({
  mark,
  fallback: Fallback,
  name,
  size,
  label,
  className
}: BrandIconProps) {
  const decorativeProps =
    label === undefined
      ? { 'aria-hidden': true as const }
      : { role: 'img' as const, 'aria-label': label };

  if (mark !== null) {
    return (
      <svg
        viewBox='0 0 24 24'
        width={size}
        height={size}
        fill='currentColor'
        className={cn('shrink-0', className)}
        {...decorativeProps}
      >
        <path d={mark.path} />
      </svg>
    );
  }

  if (Fallback !== undefined) {
    return <Fallback size={size} className={cn('shrink-0', className)} {...decorativeProps} />;
  }

  const dimension = `${size}px`;
  return (
    <span
      className={cn(
        'bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center rounded-full font-medium leading-none',
        className
      )}
      style={{ width: dimension, height: dimension, fontSize: `${Math.round(size * 0.55)}px` }}
      {...decorativeProps}
    >
      {initialLetter(name)}
    </span>
  );
}
