import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/errors';

/**
 * The one error treatment for a failed settings query: `Alert
 * variant='destructive'` plus a retry, instead of a bare `<p
 * className='text-destructive'>` or a silently-empty "No results" list.
 */
export function QueryErrorAlert({
  error,
  title = 'Failed to load',
  fallback = 'Something went wrong.',
  onRetry
}: {
  error: unknown;
  title?: string;
  fallback?: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant='destructive'>
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{errorMessage(error, fallback)}</p>
        <Button size='sm' variant='outline' onClick={onRetry}>
          Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
