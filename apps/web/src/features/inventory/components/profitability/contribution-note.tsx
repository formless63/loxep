import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Icons } from '@/components/icons';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * The mandatory "this is not margin" disclaimer that ships with
 * `@loxep/inventory/profitability.ts`'s `CONTRIBUTION_LABEL`. Every surface
 * that displays a realized-contribution figure must say this — never
 * "profit" — so it renders twice on this page: once as a persistent,
 * non-dismissible banner at the top, and once anchored directly to each
 * "Realized contribution" column via {@link ContributionInfo} so the caveat
 * travels with the number, not just the page.
 */
export function ContributionBanner({ label }: { label: string }) {
  return (
    <Alert>
      <Icons.info />
      <AlertTitle>Contribution, not profit</AlertTitle>
      <AlertDescription>
        Every &ldquo;realized contribution&rdquo; figure on this page is {label}. It excludes
        overhead, storage, labor, and payout-level fees — those are a later phase.
      </AlertDescription>
    </Alert>
  );
}

/** Small info-icon tooltip to pair with a "Realized contribution" column header or cell. */
export function ContributionInfo({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type='button'
          className='inline-flex items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring'
          aria-label='What is realized contribution?'
        >
          <Icons.info className='size-3.5' />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
