import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/icons';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { formatTimestampPrecise } from '@/lib/format';
import type { AuditEventDto } from '@/server/audit-functions';
import { computeAuditDiff, hasAuditSnapshot, type AuditDiffEntryStatus } from './diff';

const STATUS_LABEL: Record<AuditDiffEntryStatus, string> = {
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
  unchanged: 'Unchanged'
};

const STATUS_TONE = {
  added: 'success',
  removed: 'destructive',
  changed: 'warning',
  unchanged: 'outline'
} as const satisfies Record<AuditDiffEntryStatus, Tone>;

/**
 * Renders one side of a diff entry. `present` is `false` for the side that
 * never had the key at all (the "before" side of an `added` entry, the
 * "after" side of a `removed` one) — that is deliberately distinct from a
 * `null` VALUE, which is rendered as the literal word `null` rather than
 * collapsing both cases into the same blank dash (Nulls and absence are
 * different facts about a config change).
 */
function DiffValue({ value, present }: { value: unknown; present: boolean }) {
  if (!present) {
    return <span className='text-xs text-muted-foreground italic'>not set</span>;
  }
  if (value === null) {
    return <span className='text-xs text-muted-foreground italic'>null</span>;
  }
  if (typeof value === 'object') {
    return (
      <pre className='max-w-full overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words'>
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }
  return <span className='text-xs break-words'>{String(value)}</span>;
}

/**
 * The row expander's content (loxep-161): a key-level diff, not a raw JSON
 * dump. `DataTable` has no built-in expandable-subrow mechanism today (its
 * body renders exactly one `<TableRow>` per data row — see
 * `@/components/ui/table/data-table.tsx`), and extending that shared
 * primitive is out of this bead's fence since every other product table
 * depends on its current shape. A per-row `Sheet` trigger is the sanctioned
 * "row actions" affordance instead (Frontend Standards' `/starter/users`
 * reference: "Data table with row actions and sheet form") — functionally
 * the same "click the row, see the detail" expansion, in a panel instead of
 * inline.
 */
export function AuditDiffSheet({
  event,
  trigger
}: {
  event: AuditEventDto;
  trigger: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [showUnchanged, setShowUnchanged] = React.useState(false);

  const entries = React.useMemo(
    () => computeAuditDiff(event.before, event.after),
    [event.before, event.after]
  );
  const changed = entries.filter((entry) => entry.status !== 'unchanged');
  const unchanged = entries.filter((entry) => entry.status === 'unchanged');
  const snapshot = hasAuditSnapshot(event.before, event.after);
  const metadataKeys = Object.keys(event.metadata);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent className='w-full gap-0 sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle className='font-mono text-base'>{event.action}</SheetTitle>
          <SheetDescription>
            {event.resourceType}
            {event.resourceId ? ` · ${event.resourceId}` : ''}
          </SheetDescription>
        </SheetHeader>
        <div className='flex flex-col gap-4 overflow-y-auto px-4 pb-4'>
          <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm'>
            <dt className='text-muted-foreground'>When</dt>
            <dd className='tabular-nums'>{formatTimestampPrecise(event.occurredAt)}</dd>
            <dt className='text-muted-foreground'>Actor</dt>
            <dd>{event.actorDisplayName}</dd>
            {event.requestId && (
              <>
                <dt className='text-muted-foreground'>Request</dt>
                <dd className='font-mono text-xs break-all'>{event.requestId}</dd>
              </>
            )}
          </dl>

          {!snapshot ? (
            <p className='text-sm text-muted-foreground'>
              No before/after snapshot was recorded for this event.
            </p>
          ) : (
            <div className='flex flex-col gap-2'>
              {changed.length === 0 ? (
                <p className='text-sm text-muted-foreground'>No field-level changes recorded.</p>
              ) : (
                changed.map((entry) => (
                  <div key={entry.key} className='rounded-md border p-2'>
                    <div className='mb-1 flex items-center justify-between gap-2'>
                      <span className='font-mono text-xs font-medium'>{entry.key}</span>
                      <ToneBadge tone={STATUS_TONE[entry.status]}>
                        {STATUS_LABEL[entry.status]}
                      </ToneBadge>
                    </div>
                    <div className='grid grid-cols-1 gap-2 sm:grid-cols-2'>
                      <div>
                        <div className='mb-0.5 text-[11px] text-muted-foreground uppercase'>
                          Before
                        </div>
                        <DiffValue value={entry.oldValue} present={entry.status !== 'added'} />
                      </div>
                      <div>
                        <div className='mb-0.5 text-[11px] text-muted-foreground uppercase'>
                          After
                        </div>
                        <DiffValue value={entry.newValue} present={entry.status !== 'removed'} />
                      </div>
                    </div>
                  </div>
                ))
              )}

              {unchanged.length > 0 && (
                <div>
                  <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    onClick={() => setShowUnchanged((value) => !value)}
                  >
                    <Icons.chevronDown
                      className={
                        showUnchanged ? 'rotate-180 transition-transform' : 'transition-transform'
                      }
                    />
                    {showUnchanged ? 'Hide' : 'Show'} {unchanged.length} unchanged field
                    {unchanged.length === 1 ? '' : 's'}
                  </Button>
                  {showUnchanged && (
                    <div className='mt-2 flex flex-col gap-2'>
                      {unchanged.map((entry) => (
                        <div
                          key={entry.key}
                          className='rounded-md border border-dashed p-2 opacity-70'
                        >
                          <div className='mb-1 font-mono text-xs font-medium'>{entry.key}</div>
                          <DiffValue value={entry.newValue} present />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {metadataKeys.length > 0 && (
            <div>
              <div className='mb-1 text-xs font-medium text-muted-foreground'>Metadata</div>
              <pre className='max-w-full overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words'>
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
