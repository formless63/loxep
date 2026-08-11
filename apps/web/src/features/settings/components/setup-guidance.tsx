import * as React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

/**
 * Shared "where to get these" scaffolding for the integration setup surfaces.
 *
 * A credential form that only labels its fields makes an operator leave the
 * app to find out what to type; these pieces let each dialog carry the
 * provider's own set-up path inline, in the same voice as the rest of
 * settings. Nothing here is provider-specific — the copy lives with each
 * dialog, next to the fields it explains.
 *
 * Deliberately small: a disclosure shell, an ordered step list, an external
 * link that always opens a new tab (so a half-filled credential form is never
 * navigated away from), a callout for the one fact that blocks people, and a
 * copyable value for facts that are properties of THIS deployment rather than
 * of the provider's documentation.
 */

/**
 * Collapsible guidance panel. `defaultOpen` is the norm for these dialogs —
 * guidance that must be discovered before it can teach is not guidance — but
 * it stays collapsible so a returning operator can fold it away.
 */
export function SetupGuidance({
  title = 'Where to get these',
  defaultOpen = true,
  children
}: {
  title?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className='rounded-lg border bg-muted/30'>
      <CollapsibleTrigger className='flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium hover:underline'>
        {title}
        <Icons.chevronDown
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden='true'
        />
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-3 px-3 pb-3 text-sm text-muted-foreground'>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Numbered steps — the shape every provider's set-up path takes. */
export function GuidanceSteps({ children }: { children: React.ReactNode }) {
  return <ol className='list-decimal space-y-2 pl-5 [&>li]:pl-1'>{children}</ol>;
}

/** One step; nest `<GuidanceNote>` or a copyable value inside for detail. */
export function GuidanceStep({ children }: { children: React.ReactNode }) {
  return <li className='leading-relaxed'>{children}</li>;
}

/** Sub-detail under a step, or a standalone aside under the steps. */
export function GuidanceNote({ children }: { children: React.ReactNode }) {
  return <p className='mt-1 text-xs leading-relaxed'>{children}</p>;
}

/**
 * A fact that blocks people if they do not know it up front (an environment
 * mismatch, a credential shown only once). Loud enough to be read before the
 * step it guards, quiet enough not to look like an error.
 */
export function GuidanceCallout({ children }: { children: React.ReactNode }) {
  return (
    <div className='flex gap-2 rounded-md border border-dashed px-3 py-2 text-xs leading-relaxed'>
      <Icons.info className='mt-0.5 size-4 shrink-0' aria-hidden='true' />
      <div className='space-y-1'>{children}</div>
    </div>
  );
}

/**
 * External documentation/portal link. Always a new tab: these links are read
 * alongside a partly-filled credential form, and losing that form to a
 * navigation would cost more than the extra tab.
 */
export function GuidanceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer noopener'
      className='inline-flex items-baseline gap-1 font-medium text-foreground underline underline-offset-4'
    >
      {children}
      <Icons.externalLink className='size-3 self-center' aria-hidden='true' />
    </a>
  );
}

/**
 * A value the operator must transfer somewhere else verbatim, with a copy
 * button. Used for deployment-specific facts (the eBay callback URL) where a
 * documented example would be wrong for every installation but this one.
 *
 * `navigator.clipboard` is unavailable on insecure non-localhost origins, so
 * the value is always shown as selectable text and the button reports its own
 * failure rather than silently doing nothing.
 */
export function CopyableValue({
  label,
  value,
  copyLabel = 'Copy'
}: {
  label?: string;
  /** `null` renders the placeholder instead of a copy affordance. */
  value: string | null;
  copyLabel?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast.error('Could not copy — select the value and copy it manually.');
    }
  }

  return (
    <div className='space-y-1'>
      {label !== undefined && <p className='text-xs font-medium text-foreground'>{label}</p>}
      <div className='flex items-center gap-2 rounded-md border bg-background px-2 py-1.5'>
        <code className='min-w-0 flex-1 truncate font-mono text-xs text-foreground select-all'>
          {value ?? 'Not available'}
        </code>
        <Button
          type='button'
          size='xs'
          variant='ghost'
          onClick={() => void copy()}
          disabled={value === null}
          aria-label={copied ? 'Copied' : copyLabel}
        >
          {copied ? <Icons.check /> : <Icons.copy />}
          {copied ? 'Copied' : copyLabel}
        </Button>
      </div>
    </div>
  );
}
