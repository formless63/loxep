import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Icons } from '@/components/icons';
import { errorMessage } from '@/lib/errors';
import { formatRelativeTime } from '@/lib/format';
import { estateErrorSentence, type EstateErrorKind } from '../error-taxonomy';
import type { EstateSectionResult } from '../types';

/**
 * ONE section of an estate page (Estate Browsers Design §2.2/§2.6) —
 * clock-stamped (Rule P4: every section stamps its OWN `readAt`, never a
 * page-level "last updated") and rendering the four honesty states (Rule
 * P13) generically for every provider:
 *
 * - a `useQuery` still `isPending`/`isError` at the TRANSPORT layer (Loxep's
 *   own server unreachable, a genuine bug) renders the loading skeleton or a
 *   generic retryable error — this is NOT one of the four states, it is
 *   "the read has not completed yet";
 * - once settled, `result`'s own `status` drives the four states: `'ok'`
 *   with an empty `data` is EMPTY, `'ok'` with non-empty `data` renders
 *   `children`, `'blocked'` renders the reason verbatim, `'error'` renders
 *   the classified kind's own sentence plus the provider's message and a
 *   retry.
 *
 * `'Absent'` (the fourth state) is NOT rendered by this component at all —
 * per Rule P13 it means the section does not apply to this connection, which
 * is a decision the PARENT makes by not mounting `EstateSection` in the
 * first place, never something this component can detect from a result.
 */
export function EstateSection<T>({
  title,
  description,
  isPending,
  isError,
  error,
  onRetry,
  result,
  isEmpty,
  emptyMessage,
  skeletonRows = 3,
  headerAction,
  children
}: {
  title: string;
  /** Names the call this section made — Estate Browsers Design §2.2's own requirement. */
  description: string;
  isPending: boolean;
  isError: boolean;
  error?: unknown;
  onRetry: () => void;
  result: EstateSectionResult<T> | undefined;
  isEmpty: (data: T) => boolean;
  emptyMessage: string;
  skeletonRows?: number;
  /**
   * An optional section-level write affordance (e.g. "New mailbox"), rendered
   * top-right of the header via shadcn's `CardAction` slot. Additive-only —
   * every existing caller that omits it renders exactly as before. First
   * used by the Purelymail estate's Mailboxes/Routing rules sections
   * (loxep-4xo) for a section-level CREATE next to their own row-level
   * "Delete…" (Rule P10: mounts an existing service-layer write, same as
   * every other estate action; Rule P14 blocked-state rendering is the
   * caller's own responsibility, same as any other button here).
   */
  headerAction?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
        <CardDescription>
          {description}
          {result !== undefined && (
            <> — read just now ({formatRelativeTime(result.readAt)}), never stored.</>
          )}
        </CardDescription>
        {headerAction !== undefined && <CardAction>{headerAction}</CardAction>}
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className='flex flex-col gap-2'>
            {Array.from({ length: skeletonRows }, (_, index) => (
              <Skeleton key={index} className='h-10 w-full' />
            ))}
          </div>
        ) : isError ? (
          <Alert variant='destructive'>
            <AlertTitle>Could not read this section</AlertTitle>
            <AlertDescription className='flex flex-col items-start gap-2'>
              <span>{errorMessage(error, 'Something went wrong.')}</span>
              <Button size='sm' variant='outline' onClick={onRetry}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : result === undefined ? null : result.status === 'blocked' ? (
          <Alert variant='warning'>
            <Icons.warning />
            <AlertTitle>Nothing to read here yet</AlertTitle>
            <AlertDescription>{result.reason}</AlertDescription>
          </Alert>
        ) : result.status === 'error' ? (
          <Alert variant='destructive'>
            <AlertTitle>
              {estateErrorSentence({
                kind: result.kind,
                message: result.message,
                localRateBudget: result.localRateBudget
              })}
            </AlertTitle>
            <AlertDescription className='flex flex-col items-start gap-2'>
              <span>{result.message}</span>
              <Button size='sm' variant='outline' onClick={onRetry}>
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : isEmpty(result.data) ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.integrations />
              </EmptyMedia>
              <EmptyTitle>Nothing here</EmptyTitle>
              <EmptyDescription>{emptyMessage}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          children(result.data)
        )}
      </CardContent>
    </Card>
  );
}

export type { EstateErrorKind };
