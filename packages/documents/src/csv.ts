/**
 * CSV expense import staging: parsing, operator-guided column mapping, and
 * the duplicate-detection fingerprint.
 *
 * From `flipping-lifecycle-design.md`'s "Import: CSV yes, OFX no" and "The
 * staging table is shared with the parser" — a CSV import stages into the
 * SAME `document_line_candidates` table a parsed receipt does. It needs no
 * {@link ReceiptParser} backend (a CSV is text, not an image to read), so
 * this module is independent of `parser.ts`/`manual-parser.ts` except for
 * reusing the latter's exact-decimal-string normalization helpers.
 *
 * Idempotency is the shipped house pattern — *detect, do not constrain*
 * (`orders`'s answer to the same question): {@link computeRowFingerprint}
 * produces a deterministic key from a row's own values, and the CALLER (the
 * document service) is responsible for warning when that fingerprint has
 * already been committed. Nothing here enforces uniqueness.
 */
import { createHash } from "node:crypto";
import { normalizeDateString, normalizeMoneyString } from "./manual-parser.ts";

/** The columns a CSV expense import understands. `amount` is the only one every row must resolve. */
export const CSV_FIELDS = ["date", "description", "amount", "payee", "currency"] as const;
export type CsvField = (typeof CSV_FIELDS)[number];

/** `field -> source header name`. A field absent from the mapping is left unset on every row. */
export type CsvColumnMapping = Partial<Record<CsvField, string>>;

export interface CsvParseResult {
  headers: string[];
  /** Each row is header-order-aligned, same length as `headers` (short rows are padded with `""`). */
  rows: string[][];
}

/**
 * A small RFC 4180-shaped CSV parser: quoted fields (with embedded commas,
 * newlines, and doubled-quote escaping), `\r\n`/`\n` line endings, and a
 * trailing blank line ignored. No streaming — CSV expense exports are a few
 * hundred rows at most, and this importer's dry-run preview needs the whole
 * table in memory regardless.
 */
export function parseCsvText(text: string): CsvParseResult {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  function pushField(): void {
    row.push(field);
    field = "";
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
    if (char === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (char === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  // Flush the last field/row unless the file ended on a clean newline.
  if (field !== "" || row.length > 0) {
    pushRow();
  }

  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ""));
  const [headerRow, ...dataRows] = nonEmpty;
  const headers = (headerRow ?? []).map((h) => h.trim());
  const width = headers.length;
  const paddedRows = dataRows.map((r) => {
    const padded = [...r];
    while (padded.length < width) padded.push("");
    return padded.slice(0, width);
  });
  return { headers, rows: paddedRows };
}

/**
 * Header-name synonyms, matched case-insensitively against a normalized
 * (lowercased, non-alphanumeric-stripped) form of each header — the "best
 * guess from header names" the design asks for. Never authoritative: the
 * operator confirms or corrects the mapping before any preview runs.
 */
const FIELD_SYNONYMS: Record<CsvField, string[]> = {
  date: ["date", "transactiondate", "posteddate", "trandate", "when"],
  description: ["description", "memo", "details", "item", "narrative", "desc"],
  amount: ["amount", "total", "price", "cost", "debit", "value"],
  payee: ["payee", "vendor", "merchant", "payeename", "vendorname", "who"],
  currency: ["currency", "curr", "ccy"],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

/** Best-guess `field -> header` mapping from header names alone. Never stored until a second import proves the shape recurs (the design's own rule). */
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

export interface CsvCandidateInput {
  lineNumber: number;
  description: string | null;
  lineAmount: string | null;
  lineDate: string | null;
  currency: string | null;
  /** `null` when the row could not resolve a payee for the fingerprint (still fingerprinted on the other fields). */
  payeeName: string | null;
  rowFingerprint: string;
  /** Populated when a field failed to normalize — surfaced in the dry-run preview, never silently dropped. */
  rowWarnings: string[];
}

/**
 * A deterministic key from a row's OWN values — never a database identity,
 * never random. Two rows with identical date/amount/description/payee
 * fingerprint identically on purpose (the design's "two identical coffees"
 * case): the caller decides whether that is a real duplicate or not.
 */
export function computeRowFingerprint(input: {
  lineDate: string | null;
  lineAmount: string | null;
  description: string | null;
  payeeName: string | null;
}): string {
  const parts = [
    input.lineDate ?? "",
    input.lineAmount ?? "",
    (input.description ?? "").trim().toLowerCase(),
    (input.payeeName ?? "").trim().toLowerCase(),
  ];
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 16);
}

/**
 * Map every staged row through the operator's column mapping into candidate
 * inputs, normalizing money and dates exactly (never `parseFloat`). A row
 * whose `amount` does not normalize is still returned (with a warning) so
 * the dry-run preview can show it rather than silently dropping a line —
 * "the first thing anyone does with an importer is import the wrong file".
 */
export function mapCsvRows(
  parsed: CsvParseResult,
  mapping: CsvColumnMapping,
  options: { defaultCurrency?: string } = {},
): CsvCandidateInput[] {
  const indexOf = (field: CsvField): number => {
    const header = mapping[field];
    if (header === undefined) return -1;
    return parsed.headers.indexOf(header);
  };
  const dateIdx = indexOf("date");
  const descriptionIdx = indexOf("description");
  const amountIdx = indexOf("amount");
  const payeeIdx = indexOf("payee");
  const currencyIdx = indexOf("currency");

  return parsed.rows.map((row, index): CsvCandidateInput => {
    const warnings: string[] = [];

    const rawDate = dateIdx >= 0 ? (row[dateIdx] ?? "") : "";
    const lineDate = rawDate.trim() === "" ? null : normalizeDateString(rawDate);
    if (rawDate.trim() !== "" && lineDate === null) {
      warnings.push(`could not read "${rawDate}" as a date`);
    }

    const rawAmount = amountIdx >= 0 ? (row[amountIdx] ?? "") : "";
    const lineAmount = rawAmount.trim() === "" ? null : normalizeMoneyString(rawAmount);
    if (rawAmount.trim() !== "" && lineAmount === null) {
      warnings.push(`could not read "${rawAmount}" as an amount`);
    } else if (rawAmount.trim() === "") {
      warnings.push("row has no amount");
    }

    const description =
      descriptionIdx >= 0 && (row[descriptionIdx] ?? "").trim() !== ""
        ? (row[descriptionIdx] ?? "").trim()
        : null;
    const payeeName =
      payeeIdx >= 0 && (row[payeeIdx] ?? "").trim() !== "" ? (row[payeeIdx] ?? "").trim() : null;
    const rawCurrency =
      currencyIdx >= 0 && (row[currencyIdx] ?? "").trim() !== ""
        ? (row[currencyIdx] ?? "").trim().toUpperCase()
        : null;
    const currency = rawCurrency ?? options.defaultCurrency?.toUpperCase() ?? null;

    return {
      lineNumber: index + 1,
      description,
      lineAmount,
      lineDate,
      currency,
      payeeName,
      rowFingerprint: computeRowFingerprint({ lineDate, lineAmount, description, payeeName }),
      rowWarnings: warnings,
    };
  });
}
