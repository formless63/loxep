import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// formatBytes lives in `@/lib/format` now (Frontend Standards: date-fns/Intl
// formatting is centralized in lib/format). Re-exported here so existing
// `@/lib/utils` imports keep working.
export { formatBytes } from './format';
