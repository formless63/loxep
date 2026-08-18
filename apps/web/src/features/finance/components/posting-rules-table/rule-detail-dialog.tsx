import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyTitle, EmptyHeader } from '@/components/ui/empty';
import type { PostingRuleListItemDto } from '@/server/posting-functions';

/**
 * Match criteria + target accounts for one rule's current version — the
 * "why did this post to Suspense" answer the audit named. Read-only: rule
 * authoring is out of this bead's scope.
 */
export default function RuleDetailDialog({
  rule,
  onOpenChange
}: {
  rule: PostingRuleListItemDto | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={rule !== null} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{rule?.name}</DialogTitle>
          <DialogDescription>
            <span className='font-mono text-xs'>{rule?.code}</span> · {rule?.bookLabel}
          </DialogDescription>
        </DialogHeader>
        {rule?.currentVersion === null || rule?.currentVersion === undefined ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyTitle>No active version</EmptyTitle>
              <EmptyDescription>This rule has never had a version activated.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className='flex flex-col gap-4'>
            <div>
              <h3 className='text-muted-foreground mb-1.5 text-xs font-medium'>
                Match criteria (version {rule.currentVersion.version})
              </h3>
              {rule.currentVersion.predicates.length === 0 ? (
                <p className='text-sm'>Matches every fact of this type — no predicates set.</p>
              ) : (
                <ul className='flex flex-col gap-1'>
                  {rule.currentVersion.predicates.map((predicate) => (
                    <li key={predicate.label} className='flex justify-between gap-3 text-sm'>
                      <span className='text-muted-foreground'>{predicate.label}</span>
                      <span className='font-mono text-xs'>{predicate.value}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className='text-muted-foreground mb-1.5 text-xs font-medium'>Target lines</h3>
              <ul className='flex flex-col gap-1.5'>
                {rule.currentVersion.lines.map((line) => (
                  <li
                    key={line.lineNumber}
                    className='flex items-center justify-between gap-3 text-sm'
                  >
                    <span className='flex items-center gap-2'>
                      <Badge variant='outline' className='font-mono text-xs'>
                        #{line.lineNumber}
                      </Badge>
                      {line.target.kind === 'unresolvedAccount' ? (
                        <span className='text-muted-foreground font-mono text-xs'>
                          account {line.target.label}
                        </span>
                      ) : (
                        <span>{line.target.label}</span>
                      )}
                    </span>
                    <span className='text-muted-foreground text-xs'>
                      {line.isRemainder
                        ? 'remainder'
                        : `${line.amountSource} × ${line.amountMultiplier}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
