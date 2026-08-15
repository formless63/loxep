/**
 * The manual-assisted backend — the only {@link ReceiptParser} this milestone
 * ships (OQ3, resolved by owner directive: manual-assisted only) — plus the
 * exact-decimal-string money/date normalization helpers `csv.ts` builds on.
 *
 * ## Why "parsing" produces zero lines
 *
 * A self-hosted Loxep with no OCR/LLM backend cannot read a receipt image at
 * all — {@link manualParser}'s `parse()` is a structural placeholder that
 * proves the interface is satisfiable with zero automation and returns an
 * empty candidate set with a warning. The operator transcribes the receipt by
 * hand, line by line, through the document service's line CRUD
 * (`candidates.ts`'s `addLine`) — a "manual transcription reports confidence
 * `1.0` because a human typed it" (the design's own words), which this module
 * honors by defaulting every hand-added line to `1.0` at the call site, not
 * here (this file has no database handle and writes nothing).
 *
 * ## Normalization is deliberately narrow
 *
 * `normalizeMoneyString`/`normalizeDateString` cover the shapes a card
 * export or a hand-typed transcription actually produces — US-style
 * thousands separators, parenthesized negatives, ISO and US-slash dates.
 * Neither guesses at ambiguous input (`01/02/2026` is read as US
 * `MM/DD/YYYY`, never day-first) — an operator reviews every row before
 * anything is confirmed, so a wrong guess costs a correction, not a bad
 * fact reaching `expenses`.
 */
import type { ParseResult, ReceiptParser } from "./parser.ts";

export const MANUAL_PARSER_ID = "manual";
export const MANUAL_PARSER_LABEL = "Manual transcription";

/** Reported on every hand-typed candidate line — a human typed it, so confidence is exact. */
export const MANUAL_LINE_CONFIDENCE = 1;

/**
 * The one backend this milestone ships. `parse()` never inspects the media
 * object's bytes (there is no OCR/LLM step to do so) — it returns an empty
 * `ParseResult` so the review UI's "add a line by hand" path is the only way
 * candidates appear for a manually-transcribed document, which is honest
 * about what "manual-assisted" means.
 */
export const manualParser: ReceiptParser = {
  id: MANUAL_PARSER_ID,
  label: MANUAL_PARSER_LABEL,
  parse: (input) =>
    Promise.resolve<ParseResult>({
      parserId: MANUAL_PARSER_ID,
      parsedAt: new Date(),
      currency: input.hints?.currency ?? null,
      documentTotal: input.hints?.expectedTotal ?? null,
      text: null,
      lines: [],
      warnings: [
        "manual-assisted backend produces no automatic lines — transcribe the document by hand in the review screen. A hand-typed line reports confidence 1.0 because a human typed it.",
      ],
    }),
};

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Normalize a raw string (as typed, or as a CSV cell arrives) into a plain
 * decimal string suitable for `numeric(20,6)` — or `null` when it cannot be
 * read as money at all. Never rounds, never uses `parseFloat`/`Number`.
 *
 * Handles: a leading currency symbol (`$`, `£`, `€`), surrounding
 * whitespace, US-style thousands commas (`1,234.56`), and parenthesized
 * negatives (`(12.50)` → `-12.50`, the accounting convention for a credit).
 */
export function normalizeMoneyString(raw: string): string | null {
  let value = raw.trim();
  if (value === "") return null;

  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1).trim();
  } else if (value.startsWith("+")) {
    value = value.slice(1).trim();
  }

  // Strip a single leading currency symbol and any thousands-separator commas.
  value = value.replace(/^[$£€¥]\s*/, "").replaceAll(",", "").trim();

  if (!PLAIN_DECIMAL.test(value)) return null;
  if (negative && value.startsWith("-")) {
    // Already carries a sign (shouldn't happen after stripping above, but
    // refuse rather than double-negate).
    return null;
  }
  return negative ? `-${value}` : value;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const US_SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const US_DASH_DATE = /^(\d{1,2})-(\d{1,2})-(\d{4})$/;

function pad2(value: string): string {
  return value.padStart(2, "0");
}

/**
 * Normalize a raw string into an ISO `YYYY-MM-DD` calendar date — or `null`
 * when it cannot be read as one. Read order: ISO first, then US
 * `MM/DD/YYYY` (a card export's dominant shape), then US `MM-DD-YYYY`.
 * Deliberately does NOT attempt day-first (`DD/MM/YYYY`) — that ambiguity is
 * for the operator's review, not a guess this function makes silently.
 */
export function normalizeDateString(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  const iso = ISO_DATE.exec(value);
  if (iso) {
    const [, year, month, day] = iso;
    return `${year}-${month}-${day}`;
  }

  const usSlash = US_SLASH_DATE.exec(value);
  if (usSlash) {
    const [, month, day, year] = usSlash;
    return `${year}-${pad2(month ?? "")}-${pad2(day ?? "")}`;
  }

  const usDash = US_DASH_DATE.exec(value);
  if (usDash) {
    const [, month, day, year] = usDash;
    return `${year}-${pad2(month ?? "")}-${pad2(day ?? "")}`;
  }

  return null;
}
