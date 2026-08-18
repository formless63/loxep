/**
 * Key-level diff between an audit event's `before`/`after` snapshots
 * (loxep-161). The row expander renders THIS, never a raw JSON dump: for
 * each top-level key that changed, an added key, or a removed key, one
 * entry; unchanged keys are still returned (so a caller can offer "show
 * unchanged fields") but are collapsed by default in the view component.
 *
 * A nested object/array value is left as-is (`unknown`) — the view component
 * renders it as compact JSON inside its cell — but the TOP level is always a
 * genuine key-by-key comparison, not two side-by-side JSON blobs.
 *
 * `before`/`after` are already redacted server-side at write time
 * (`@loxep/domain`'s `createAuditService.append`) before this ever runs, so
 * this module does no redaction of its own — it only compares what it is
 * given.
 */

export type AuditDiffEntryStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export interface AuditDiffEntry {
  key: string;
  status: AuditDiffEntryStatus;
  oldValue: unknown;
  newValue: unknown;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `JSON.stringify` equality is sufficient here — every value already round-tripped through `jsonb`, so it is JSON-safe by construction (no `Date`/`Map`/`undefined` members to lose). */
function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Returns one entry per top-level key across `before` ∪ `after`, sorted
 * alphabetically for a stable render order. When neither snapshot is a
 * plain object (e.g. both `null` — an action recorded with no snapshot at
 * all, or a genuinely scalar/array top level) this returns `[]`; the view
 * component renders its own "no detail recorded" state for that case.
 */
export function computeAuditDiff(before: unknown, after: unknown): AuditDiffEntry[] {
  const beforeObj = isPlainRecord(before) ? before : {};
  const afterObj = isPlainRecord(after) ? after : {};
  const keys = Array.from(new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])).toSorted(
    (a, b) => a.localeCompare(b)
  );

  return keys.map((key) => {
    const hasBefore = Object.hasOwn(beforeObj, key);
    const hasAfter = Object.hasOwn(afterObj, key);
    const oldValue = beforeObj[key];
    const newValue = afterObj[key];

    let status: AuditDiffEntryStatus;
    if (!hasBefore && hasAfter) {
      status = 'added';
    } else if (hasBefore && !hasAfter) {
      status = 'removed';
    } else if (!deepEqual(oldValue, newValue)) {
      status = 'changed';
    } else {
      status = 'unchanged';
    }

    return { key, status, oldValue, newValue };
  });
}

/** Whether `before`/`after` were plain objects at all — distinguishes "no changes" from "no snapshot recorded". */
export function hasAuditSnapshot(before: unknown, after: unknown): boolean {
  return isPlainRecord(before) || isPlainRecord(after);
}
