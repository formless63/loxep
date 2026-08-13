/**
 * Centralized display formatting for Loxep product surfaces.
 *
 * `date-fns` usage is allowed ONLY inside this file — product components
 * import the helpers below, never `date-fns` directly (see Frontend
 * Standards, "Standard formats").
 *
 * Convention shared by every helper here: null/undefined/invalid input
 * renders as an em dash ('—'), never an empty string, never "Invalid Date".
 */
import { format as formatDateFns, intervalToDuration, isValid } from 'date-fns';

const EM_DASH = '—';

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    const date = value instanceof Date ? value : new Date(value);
    return isValid(date) ? date : null;
  } catch {
    return null;
  }
}

export function formatDate(
  date: Date | string | number | undefined,
  opts: Intl.DateTimeFormatOptions = {}
) {
  if (!date) return '';

  try {
    return new Intl.DateTimeFormat('en-US', {
      month: opts.month ?? 'long',
      day: opts.day ?? 'numeric',
      year: opts.year ?? 'numeric',
      ...opts
    }).format(new Date(date));
  } catch {
    return '';
  }
}

/** Absolute timestamp at minute precision — the house format for tables. */
export function formatDateTime(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return EM_DASH;
  try {
    return formatDateFns(date, 'yyyy-MM-dd HH:mm');
  } catch {
    return EM_DASH;
  }
}

/** Absolute timestamp at second precision — for event/audit logs. */
export function formatTimestampPrecise(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return EM_DASH;
  try {
    return formatDateFns(date, 'yyyy-MM-dd HH:mm:ss');
  } catch {
    return EM_DASH;
  }
}

/**
 * Hour-of-day axis tick (`HH:mm`) for trailing-24h charts. Exists so chart
 * axes stop reaching for `date-fns` directly at the call site — `date-fns`
 * usage belongs in this file only (Frontend Standards, "Standard formats").
 */
export function formatHourLabel(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return EM_DASH;
  try {
    return formatDateFns(date, 'HH:mm');
  } catch {
    return EM_DASH;
  }
}

const RELATIVE_TIME_DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: 'seconds' },
  { amount: 60, unit: 'minutes' },
  { amount: 24, unit: 'hours' },
  { amount: 7, unit: 'days' },
  { amount: 4.34524, unit: 'weeks' },
  { amount: 12, unit: 'months' },
  { amount: Number.POSITIVE_INFINITY, unit: 'years' }
];

/**
 * Relative time string, e.g. "3 minutes ago" or "in 2 days", via
 * `Intl.RelativeTimeFormat`. This is a relative rendering only — callers
 * should pair it with the absolute value (e.g. `formatDateTime` or
 * `formatTimestampPrecise`) in a `title`/tooltip attribute so the exact
 * time stays available on hover.
 */
export function formatRelativeTime(value: Date | string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return EM_DASH;

  try {
    const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
    let duration = (date.getTime() - Date.now()) / 1000;

    for (const division of RELATIVE_TIME_DIVISIONS) {
      if (Math.abs(duration) < division.amount) {
        return rtf.format(Math.round(duration), division.unit);
      }
      duration /= division.amount;
    }

    return rtf.format(Math.round(duration), 'years');
  } catch {
    return EM_DASH;
  }
}

/**
 * Money is PostgreSQL `numeric` and ships as a decimal string — it must
 * never round-trip through JS `number` arithmetic, comparison, or storage.
 * `Number(amount)` below is used ONLY to feed `Intl.NumberFormat` for
 * display; the decimal string itself remains the source of truth.
 *
 * When `currency` is present, renders with `Intl.NumberFormat`'s currency
 * style (symbol, thousands separator, correct locale ordering). When
 * `currency` is null/absent, renders the normalized decimal with no
 * fabricated currency — never a bare unlabeled number with an implied
 * currency. "12.5" and "12.50" both normalize to the same two-decimal
 * display.
 */
export function formatMoney(
  amount: string | null | undefined,
  currency: string | null | undefined
): string {
  if (amount === null || amount === undefined || amount.trim() === '') return EM_DASH;

  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return EM_DASH;

  const trimmedCurrency = currency?.trim();

  if (trimmedCurrency) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: trimmedCurrency
      }).format(numeric);
    } catch {
      // Invalid/unrecognized currency code — fall through to plain decimal
      // rather than throwing on a bad or legacy provider currency string.
    }
  }

  return new Intl.NumberFormat('en-US', {
    style: 'decimal',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(numeric);
}

/** Grouped integer quantity (e.g. stock/available counts). */
export function formatQuantity(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en-US').format(Math.round(value));
}

/**
 * Percent display for values already expressed in percentage units (e.g.
 * `12.34` renders as `+12.34%`, not `0.1234`). Carries an explicit sign so
 * a −40% price crash never looks identical to a +40% spike.
 */
export function formatPercent(
  value: number | null | undefined,
  opts: { decimals?: number } = {}
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const decimals = opts.decimals ?? 2;
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: 'exceptZero'
  }).format(value);
  return `${formatted}%`;
}

/**
 * Unsigned percentage for a MAGNITUDE — a success rate, a share of a total —
 * rather than a delta. `formatPercent` prints an explicit sign because a
 * signed delta must; a delivery success rate of 98.5% is not "+98.5%".
 */
export function formatRate(
  value: number | null | undefined,
  opts: { decimals?: number } = {}
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  const decimals = opts.decimals ?? 1;
  return `${new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(value)}%`;
}

/**
 * Human duration from a seconds count (uptime, backoff, poll intervals),
 * built on `date-fns` `intervalToDuration`. Resolution stops at days —
 * this is for operational durations, not calendar spans.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return EM_DASH;

  const totalSeconds = Math.max(0, Math.round(seconds));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  try {
    const duration = intervalToDuration({ start: 0, end: totalSeconds * 1000 });
    const days = (duration.years ?? 0) * 365 + (duration.months ?? 0) * 30 + (duration.days ?? 0);
    const hours = duration.hours ?? 0;
    const minutes = duration.minutes ?? 0;
    const secs = duration.seconds ?? 0;

    if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
  } catch {
    return EM_DASH;
  }
}

/**
 * Canonical score display precision: two decimal places. Scores (e.g.
 * opportunity rule scores) must render identically everywhere — the same
 * value must never show `0.8734` on one route and `0.87` on another.
 */
export function formatScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

/**
 * Human byte size (e.g. file sizes, storage backend usage). Moved from
 * `lib/utils.ts`; `lib/utils.ts` re-exports this for existing callers.
 */
export function formatBytes(
  bytes: number | null | undefined,
  opts: {
    decimals?: number;
    sizeType?: 'accurate' | 'normal';
  } = {}
): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return EM_DASH;
  }

  const { decimals = 0, sizeType = 'normal' } = opts;

  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const accurateSizes = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
  if (bytes === 0) return '0 Byte';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(decimals)} ${
    sizeType === 'accurate' ? (accurateSizes[i] ?? 'Bytes') : (sizes[i] ?? 'Bytes')
  }`;
}
