/**
 * FILL-TWO-DERIVE-THIRD for one line item's qty / unit price / subtotal
 * (expense entry v2, loxep-zk5 — `expense-entry-design.md` v2 status note,
 * section 4). When exactly two of the three numeric fields carry a value the
 * OPERATOR typed, the third is computed and displayed as DERIVED (rendered
 * muted/italic by the caller) until the operator edits it directly, at which
 * point it becomes an ordinary user-owned value and stops recomputing.
 *
 * Decimal-safe by construction: every value that could reach persistence is
 * money or a quantity at the schema's own `numeric(20,6)` scale
 * (`expense_lines.quantity`/`unit_amount`/`line_amount`), so this module
 * NEVER touches a JS `number` for the values it derives — everything is
 * parsed to an integer micro-unit (`10^-6`) `BigInt`, multiplied/divided as
 * exact integer arithmetic, and formatted back to a plain decimal string.
 * Division rounds half-up at the 6th decimal place (`multiplyMicros`/
 * `divideMicros`'s own doc); a zero divisor derives nothing rather than
 * throwing or producing `Infinity`.
 *
 * ## The ownership rule, stated once
 *
 * Each field's state is exactly one of:
 *
 * - `'user'`    — the operator typed this value; it is NEVER auto-overwritten.
 * - `'derived'` — this module computed it; the ONLY state this module ever
 *                 writes into.
 * - `'empty'`   — no value.
 *
 * `setLineItemField` recomputes and re-derives after every edit — including
 * edits to a field that is currently empty or currently derived — but only
 * ever assigns a NEW value into a field it marks `'derived'` in the same
 * call, or clears a stale `'derived'` field back to `'empty'` when the
 * two-owned-inputs precondition no longer holds (e.g. the operator cleared
 * one of the two fields that fed it). A `'user'` field is untouched by every
 * code path in this module except the one edit call that targets it
 * directly.
 */

/** `expense_lines.quantity`/`unit_amount`/`line_amount` are all `numeric(20,6)`. */
export const LINE_ITEM_DECIMAL_SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(LINE_ITEM_DECIMAL_SCALE);
const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Parses a plain decimal string to an integer micro-unit `BigInt`, rounding half-up if given more than 6 fractional digits. `null` for anything not a plain decimal (including `''`). */
function parseMicros(raw: string): bigint | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !DECIMAL_STRING_RE.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = unsigned.indexOf('.');
  const wholeDigits = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracDigits = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1);

  let magnitude: bigint;
  if (fracDigits.length <= LINE_ITEM_DECIMAL_SCALE) {
    magnitude = BigInt(wholeDigits + fracDigits.padEnd(LINE_ITEM_DECIMAL_SCALE, '0'));
  } else {
    const kept = fracDigits.slice(0, LINE_ITEM_DECIMAL_SCALE);
    const roundUp = Number(fracDigits[LINE_ITEM_DECIMAL_SCALE]) >= 5;
    magnitude = BigInt(wholeDigits + kept) + (roundUp ? 1n : 0n);
  }
  return negative ? -magnitude : magnitude;
}

/** The inverse of {@link parseMicros}. */
function formatMicros(micros: bigint): string {
  const negative = micros < 0n;
  const magnitude = negative ? -micros : micros;
  const digits = magnitude.toString().padStart(LINE_ITEM_DECIMAL_SCALE + 1, '0');
  const whole = digits.slice(0, digits.length - LINE_ITEM_DECIMAL_SCALE);
  const fraction = digits.slice(digits.length - LINE_ITEM_DECIMAL_SCALE);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** `a x b`, rounded half-up to 6dp. `null` if either input is not a plain decimal string. */
export function multiplyMicros(a: string, b: string): string | null {
  const aMicros = parseMicros(a);
  const bMicros = parseMicros(b);
  if (aMicros === null || bMicros === null) return null;
  const product = aMicros * bMicros; // scaled by SCALE_FACTOR^2
  const negative = product < 0n;
  const magnitude = negative ? -product : product;
  const quotient = magnitude / SCALE_FACTOR;
  const remainder = magnitude % SCALE_FACTOR;
  const rounded = remainder * 2n >= SCALE_FACTOR ? quotient + 1n : quotient;
  return formatMicros(negative ? -rounded : rounded);
}

/** `a / b`, rounded half-up to 6dp. `null` if either input is not a plain decimal string, or `b` is zero — the divide-by-zero guard. */
export function divideMicros(a: string, b: string): string | null {
  const aMicros = parseMicros(a);
  const bMicros = parseMicros(b);
  if (aMicros === null || bMicros === null || bMicros === 0n) return null;
  const numerator = aMicros * SCALE_FACTOR;
  const negative = numerator < 0n !== bMicros < 0n;
  const numeratorAbs = numerator < 0n ? -numerator : numerator;
  const denominatorAbs = bMicros < 0n ? -bMicros : bMicros;
  const quotient = numeratorAbs / denominatorAbs;
  const remainder = numeratorAbs % denominatorAbs;
  const rounded = remainder * 2n >= denominatorAbs ? quotient + 1n : quotient;
  return formatMicros(negative ? -rounded : rounded);
}

/* ------------------------------------------------------------ state machine */

export type LineItemFieldOwner = 'user' | 'derived' | 'empty';

export interface LineItemField {
  value: string;
  owner: LineItemFieldOwner;
}

export interface LineItemDeriveState {
  quantity: LineItemField;
  unitPrice: LineItemField;
  subtotal: LineItemField;
}

export const EMPTY_LINE_ITEM_FIELD: LineItemField = { value: '', owner: 'empty' };

export const EMPTY_LINE_ITEM_DERIVE_STATE: LineItemDeriveState = {
  quantity: EMPTY_LINE_ITEM_FIELD,
  unitPrice: EMPTY_LINE_ITEM_FIELD,
  subtotal: EMPTY_LINE_ITEM_FIELD
};

export type LineItemDeriveKey = keyof LineItemDeriveState;

const ALL_KEYS: readonly LineItemDeriveKey[] = ['quantity', 'unitPrice', 'subtotal'];

/** A field "counts" toward the two-owned-inputs rule only when the operator typed it and it is non-empty. */
function ownedValue(field: LineItemField): string | null {
  return field.owner === 'user' && field.value.trim() !== '' ? field.value : null;
}

function deriveMissing(missing: LineItemDeriveKey, state: LineItemDeriveState): string | null {
  if (missing === 'subtotal') {
    const quantity = ownedValue(state.quantity);
    const unitPrice = ownedValue(state.unitPrice);
    return quantity === null || unitPrice === null ? null : multiplyMicros(quantity, unitPrice);
  }
  if (missing === 'unitPrice') {
    const subtotal = ownedValue(state.subtotal);
    const quantity = ownedValue(state.quantity);
    return subtotal === null || quantity === null ? null : divideMicros(subtotal, quantity);
  }
  // missing === 'quantity'
  const subtotal = ownedValue(state.subtotal);
  const unitPrice = ownedValue(state.unitPrice);
  return subtotal === null || unitPrice === null ? null : divideMicros(subtotal, unitPrice);
}

/**
 * Applies one operator edit to `key` (the raw text they typed, including an
 * empty string for "cleared the field") and returns the next state —
 * pure, no mutation of `state`.
 *
 * Behaviour, exactly:
 * 1. `key` always becomes `'user'`-owned (or `'empty'` if cleared) — this is
 *    the one field this call may set to something other than `'derived'`.
 * 2. If, after that, exactly two of the three fields are `'user'`-owned, the
 *    third — which, being excluded from that two, can only be `'derived'`
 *    or `'empty'`, never `'user'` — is computed and (re)marked `'derived'`.
 *    A field the operator typed is reachable by this step only through the
 *    identity substitution `missing === key`, which cannot happen: `key` was
 *    just set to `'user'`/`'empty'` above, so it is never the excluded
 *    third field when exactly two are `'user'`-owned.
 * 3. Otherwise, any field still marked `'derived'` is stale (its two source
 *    inputs no longer both hold) and is reset to `'empty'`.
 */
export function setLineItemField(
  state: LineItemDeriveState,
  key: LineItemDeriveKey,
  rawValue: string
): LineItemDeriveState {
  const edited: LineItemField =
    rawValue.trim() === '' ? { value: '', owner: 'empty' } : { value: rawValue, owner: 'user' };
  const next: LineItemDeriveState = { ...state, [key]: edited };

  const ownedKeys = ALL_KEYS.filter((k) => ownedValue(next[k]) !== null);

  if (ownedKeys.length === 2) {
    const missing = ALL_KEYS.find((k) => !ownedKeys.includes(k));
    if (missing !== undefined) {
      const computed = deriveMissing(missing, next);
      next[missing] =
        computed === null ? { value: '', owner: 'empty' } : { value: computed, owner: 'derived' };
    }
    return next;
  }

  for (const k of ALL_KEYS) {
    if (next[k].owner === 'derived') next[k] = { value: '', owner: 'empty' };
  }
  return next;
}

/** Builds a `LineItemDeriveState` from three plain values (e.g. hydrating from a saved/prefilled row) — every non-empty value starts `'user'`-owned; no derivation runs at hydration time. */
export function lineItemDeriveStateFromValues(values: {
  quantity: string;
  unitPrice: string;
  subtotal: string;
}): LineItemDeriveState {
  return {
    quantity:
      values.quantity.trim() === ''
        ? EMPTY_LINE_ITEM_FIELD
        : { value: values.quantity, owner: 'user' },
    unitPrice:
      values.unitPrice.trim() === ''
        ? EMPTY_LINE_ITEM_FIELD
        : { value: values.unitPrice, owner: 'user' },
    subtotal:
      values.subtotal.trim() === ''
        ? EMPTY_LINE_ITEM_FIELD
        : { value: values.subtotal, owner: 'user' }
  };
}
