import { toast } from 'sonner';

/**
 * Extracts a user-facing message from a caught error, falling back to
 * `fallback` when the error isn't an `Error` instance (thrown strings,
 * non-Error rejections from server functions, etc).
 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Shared mutation `onError` idiom: `toast.error(errorMessage(error, fallback))`.
 * Use directly as a `useMutation({ onError: (error) => toastError(error, '...') })`
 * handler in place of the repeated `error instanceof Error ? error.message : '...'`
 * inline check.
 */
export function toastError(error: unknown, fallback: string): void {
  toast.error(errorMessage(error, fallback));
}
