/**
 * CSV parsing, column-mapping best-guess, row fingerprinting, and exact
 * money/date normalization — a deliberate RE-DECLARATION of
 * `@loxep/documents`'s `csv.ts`/`manual-parser.ts` normalize helpers, not an
 * import.
 *
 * IMPLEMENTATION CHOICE — no `@loxep/documents` dependency here:
 * `apps/web/package.json` does not declare `@loxep/documents` (mirrors
 * `@/server/order-sync-functions.ts`'s documented reasoning for
 * `@loxep/commerce`), and adding that dependency edge is outside this
 * change's write fence. These are pure, side-effect-free functions with no
 * database handle — re-declaring them here is four small functions, the
 * same trade `@loxep/accounting/src/decimal.ts` and
 * `@loxep/inventory/src/sql.ts` already document for their own re-declared
 * helpers. `apps/web/src/server/documents-functions.ts` re-declares the
 * SERVER-side staging/confirm logic for the same reason.
 *
 * Runs entirely CLIENT-SIDE: the operator picks a file, this module parses
 * it and computes the best-guess mapping and the dry-run preview in the
 * browser, and only the operator-confirmed, already-mapped rows cross the
 * network to `stageCsvImport` (`@/server/documents-functions`).
 */

export const CSV_FIELDS = ['date', 'description', 'amount', 'payee', 'currency'] as const;
export type CsvField = (typeof CSV_FIELDS)[number];

export type CsvColumnMapping = Partial<Record<CsvField, string>>;

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
}

/** A small RFC 4180-shaped CSV parser — see `@loxep/documents/src/csv.ts`'s `parseCsvText` for the canonical doc. */
export function parseCsvText(text: string): CsvParseResult {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const source = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  function pushField(): void {
    row.push(field);
    field = '';
  }
  function pushRow(): void {
    pushField();
    rows.push(row);
    row = [];
  }

  while (i < source.length) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (char === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    pushRow();
  }

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const [headerRow, ...dataRows] = nonEmpty;
  const headers = (headerRow ?? []).map((h) => h.trim());
  const width = headers.length;
  const paddedRows = dataRows.map((r) => {
    const padded = [...r];
    while (padded.length < width) padded.push('');
    return padded.slice(0, width);
  });
  return { headers, rows: paddedRows };
}

const FIELD_SYNONYMS: Record<CsvField, string[]> = {
  date: ['date', 'transactiondate', 'posteddate', 'trandate', 'when'],
  description: ['description', 'memo', 'details', 'item', 'narrative', 'desc'],
  amount: ['amount', 'total', 'price', 'cost', 'debit', 'value'],
  payee: ['payee', 'vendor', 'merchant', 'payeename', 'vendorname', 'who'],
  currency: ['currency', 'curr', 'ccy']
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}

export function guessColumnMapping(headers: string[]): CsvColumnMapping {
  const normalized = headers.map((h) => ({ header: h, key: normalizeHeader(h) }));
  const mapping: CsvColumnMapping = {};
  for (const field of CSV_FIELDS) {
    const synonyms = FIELD_SYNONYMS[field];
    const match = normalized.find((h) => synonyms.includes(h.key));
    if (match) mapping[field] = match.header;
  }
  return mapping;
}

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Exact-decimal-string money normalization — never `parseFloat`/`Number`. */
export function normalizeMoneyString(raw: string): string | null {
  let value = raw.trim();
  if (value === '') return null;

  let negative = false;
  if (value.startsWith('(') && value.endsWith(')')) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith('-')) {
    negative = true;
    value = value.slice(1).trim();
  } else if (value.startsWith('+')) {
    value = value.slice(1).trim();
  }

  value = value
    .replace(/^[$£€¥]\s*/, '')
    .replaceAll(',', '')
    .trim();

  if (!PLAIN_DECIMAL.test(value)) return null;
  if (negative && value.startsWith('-')) return null;
  return negative ? `-${value}` : value;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const US_DASH_DATE = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

function pad2(value: string): string {
  return value.padStart(2, '0');
}

/** ISO `YYYY-MM-DD` normalization, US-slash/US-dash aware, never day-first. */
export function normalizeDateString(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;

  const iso = ISO_DATE.exec(value);
  if (iso) {
    const [, year, month, day] = iso;
    return `${year}-${month}-${day}`;
  }
  const usSlash = US_SLASH_DATE.exec(value);
  if (usSlash) {
    const [, month, day, year] = usSlash;
    return `${year}-${pad2(month ?? '')}-${pad2(day ?? '')}`;
  }
  const usDash = US_DASH_DATE.exec(value);
  if (usDash) {
    const [, month, day, year] = usDash;
    return `${year}-${pad2(month ?? '')}-${pad2(day ?? '')}`;
  }
  return null;
}

export interface CsvCandidateInput {
  lineNumber: number;
  description: string | null;
  lineAmount: string | null;
  lineDate: string | null;
  currency: string | null;
  payeeName: string | null;
  rowFingerprint: string;
  rowWarnings: string[];
}

/** A deterministic key from a row's own values — detect, never constrain (mirrors `@loxep/documents`). */
export async function computeRowFingerprint(input: {
  lineDate: string | null;
  lineAmount: string | null;
  description: string | null;
  payeeName: string | null;
}): Promise<string> {
  const parts = [
    input.lineDate ?? '',
    input.lineAmount ?? '',
    (input.description ?? '').trim().toLowerCase(),
    (input.payeeName ?? '').trim().toLowerCase()
  ];
  const bytes = new TextEncoder().encode(parts.join(''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 16);
}

export async function mapCsvRows(
  parsed: CsvParseResult,
  mapping: CsvColumnMapping,
  options: { defaultCurrency?: string } = {}
): Promise<CsvCandidateInput[]> {
  const indexOf = (field: CsvField): number => {
    const header = mapping[field];
    if (header === undefined) return -1;
    return parsed.headers.indexOf(header);
  };
  const dateIdx = indexOf('date');
  const descriptionIdx = indexOf('description');
  const amountIdx = indexOf('amount');
  const payeeIdx = indexOf('payee');
  const currencyIdx = indexOf('currency');

  return Promise.all(
    parsed.rows.map(async (row, index): Promise<CsvCandidateInput> => {
      const warnings: string[] = [];

      const rawDate = dateIdx >= 0 ? (row[dateIdx] ?? '') : '';
      const lineDate = rawDate.trim() === '' ? null : normalizeDateString(rawDate);
      if (rawDate.trim() !== '' && lineDate === null) {
        warnings.push(`could not read "${rawDate}" as a date`);
      }

      const rawAmount = amountIdx >= 0 ? (row[amountIdx] ?? '') : '';
      const lineAmount = rawAmount.trim() === '' ? null : normalizeMoneyString(rawAmount);
      if (rawAmount.trim() !== '' && lineAmount === null) {
        warnings.push(`could not read "${rawAmount}" as an amount`);
      } else if (rawAmount.trim() === '') {
        warnings.push('row has no amount');
      }

      const description =
        descriptionIdx >= 0 && (row[descriptionIdx] ?? '').trim() !== ''
          ? (row[descriptionIdx] ?? '').trim()
          : null;
      const payeeName =
        payeeIdx >= 0 && (row[payeeIdx] ?? '').trim() !== '' ? (row[payeeIdx] ?? '').trim() : null;
      const rawCurrency =
        currencyIdx >= 0 && (row[currencyIdx] ?? '').trim() !== ''
          ? (row[currencyIdx] ?? '').trim().toUpperCase()
          : null;
      const currency = rawCurrency ?? options.defaultCurrency?.toUpperCase() ?? null;

      return {
        lineNumber: index + 1,
        description,
        lineAmount,
        lineDate,
        currency,
        payeeName,
        rowFingerprint: await computeRowFingerprint({
          lineDate,
          lineAmount,
          description,
          payeeName
        }),
        rowWarnings: warnings
      };
    })
  );
}
