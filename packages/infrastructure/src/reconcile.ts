/**
 * The reconciler: diff and apply, with `mode = 'apply' | 'check'` taking the
 * SAME code path.
 *
 * That is the property which makes drift detection trustworthy. A separate
 * read-only comparator would drift from the applier, and the first time they
 * disagreed nobody would know which was right. So there is one diff, one
 * traversal, and one place that decides whether to call the provider.
 *
 * ```text
 * read intent            dns_records where desired_deleted_at is null
 * read observed          adapter.read(), already normalized to Loxep shape
 * diff on the natural key (type, name) and the comparable attributes
 *
 * kind = 'missing'       intent has it; the provider does not
 * kind = 'modified'      both have (type, name); content or proxied differ
 * kind = 'unexpected'    the provider has it; intent does not describe it
 *
 * mode = 'apply'         create / update / delete, then resolve findings 'applied'
 * mode = 'check'         record findings only; change nothing at the provider
 * ```
 *
 * ## Record identity, and why it is not the natural key alone
 *
 * `dns_records`' UNIQUE is `(domain_id, type, name, content)` — that is the
 * key that makes storage convergent. The DIFF, however, pairs on
 * **`(type, name)`**, because a record whose content changed is a `modified`
 * finding rather than a `missing` plus an `unexpected` pair. Content is a
 * comparable attribute, not part of the pairing identity.
 *
 * The one place that distinction has teeth is a type/name that legitimately
 * has several values — an MX set, several TXT strings. Those are matched
 * content-first within the group so an unchanged member never appears as
 * drift, and only the leftovers pair up positionally. Getting this wrong
 * produces a sweep that reports drift on a correct zone forever, which is the
 * failure that makes people stop reading drift reports.
 *
 * ## What apply may NEVER do
 *
 * - **never rewrite or delete a `manual` record**, in any mode. Manual records
 *   are compared (so a hand-edit is visible) and never touched;
 * - **never delete an `unexpected` record automatically**, in any mode. Open
 *   question 3, resolved PROVISIONAL: hold that line permanently. An automatic
 *   delete is unrecoverable and assumes Loxep's intent is complete — an
 *   assumption that is wrong the first time somebody legitimately adds a
 *   record in a provider dashboard. `adopt` is the escape hatch that makes the
 *   model livable.
 */
import type {
  DnsApplyOperation,
  DnsProviderPort,
  ObservedDnsRecord,
} from "./port.ts";

/** One row of desired state, as the diff sees it. */
export interface IntentRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttlSeconds: number | null;
  priority: number | null;
  proxied: boolean;
  owner: "apex" | "wildcard" | "caa" | "mail" | "proxy_resource" | "manual";
  externalRecordId: string | null;
}

export interface MissingDiff {
  kind: "missing";
  intent: IntentRecord;
}

export interface ModifiedDiff {
  kind: "modified";
  intent: IntentRecord;
  observed: ObservedDnsRecord;
  /** Which comparable attributes actually differ. Drives the run-step summary. */
  changed: Array<"content" | "proxied" | "ttlSeconds" | "priority">;
}

export interface UnexpectedDiff {
  kind: "unexpected";
  observed: ObservedDnsRecord;
}

export interface UnchangedDiff {
  kind: "unchanged";
  intent: IntentRecord;
  observed: ObservedDnsRecord;
}

export type DnsDiffEntry =
  | MissingDiff
  | ModifiedDiff
  | UnexpectedDiff
  | UnchangedDiff;

export interface DnsDiff {
  missing: MissingDiff[];
  modified: ModifiedDiff[];
  unexpected: UnexpectedDiff[];
  unchanged: UnchangedDiff[];
  /** Every entry in one list, in a stable order, for step logging. */
  entries: DnsDiffEntry[];
}

function pairKey(record: { type: string; name: string }): string {
  return `${record.type} ${record.name}`;
}

/**
 * `ttl_seconds` comparison treats `null` as "provider default". Two records
 * that both defer to the provider are equal even though the provider will
 * report a concrete number for neither — the adapter has already translated
 * its sentinel back to `null`, which is the entire reason that translation
 * lives at the boundary.
 */
function changedAttributes(
  intent: IntentRecord,
  observed: ObservedDnsRecord,
): ModifiedDiff["changed"] {
  const changed: ModifiedDiff["changed"] = [];
  if (intent.content !== observed.content) changed.push("content");
  if (intent.proxied !== observed.proxied) changed.push("proxied");
  if (intent.ttlSeconds !== observed.ttlSeconds) changed.push("ttlSeconds");
  if ((intent.priority ?? null) !== (observed.priority ?? null)) {
    changed.push("priority");
  }
  return changed;
}

/**
 * The pure diff. No database, no network, no clock.
 *
 * `intent` must already exclude soft-deleted rows the caller does not want
 * pushed; a row with `desired_deleted_at` set is passed in ONLY when the
 * caller wants it removed at the provider, and it arrives as a `missing`
 * inversion the caller turns into a delete. Keeping that decision out of here
 * is what lets this function be exhaustively tested on shape alone.
 */
export function diffDnsRecords(
  intent: readonly IntentRecord[],
  observed: readonly ObservedDnsRecord[],
): DnsDiff {
  const diff: DnsDiff = {
    missing: [],
    modified: [],
    unexpected: [],
    unchanged: [],
    entries: [],
  };

  // Group both sides by (type, name), then match content-first inside each
  // group so an unchanged member of a multi-valued set never reads as drift.
  const observedByPair = new Map<string, ObservedDnsRecord[]>();
  for (const record of observed) {
    const key = pairKey(record);
    const bucket = observedByPair.get(key);
    if (bucket === undefined) observedByPair.set(key, [record]);
    else bucket.push(record);
  }

  const intentByPair = new Map<string, IntentRecord[]>();
  for (const record of intent) {
    const key = pairKey(record);
    const bucket = intentByPair.get(key);
    if (bucket === undefined) intentByPair.set(key, [record]);
    else bucket.push(record);
  }

  for (const [key, intentGroup] of intentByPair) {
    const observedGroup = observedByPair.get(key) ?? [];
    const takenObserved = new Set<number>();
    const unmatchedIntent: IntentRecord[] = [];

    // Pass 1: exact content matches. These are unchanged or proxy/TTL-only
    // modifications and must never be mistaken for a create+delete pair.
    for (const record of intentGroup) {
      const index = observedGroup.findIndex(
        (candidate, position) =>
          !takenObserved.has(position) && candidate.content === record.content,
      );
      if (index === -1) {
        unmatchedIntent.push(record);
        continue;
      }
      takenObserved.add(index);
      const match = observedGroup[index] as ObservedDnsRecord;
      const changed = changedAttributes(record, match);
      if (changed.length === 0) {
        diff.unchanged.push({ kind: "unchanged", intent: record, observed: match });
      } else {
        diff.modified.push({
          kind: "modified",
          intent: record,
          observed: match,
          changed,
        });
      }
    }

    // Pass 2: whatever is left pairs positionally — one leftover intent row
    // against one leftover observed row is a content change, not a
    // delete-and-recreate.
    const leftoverObserved = observedGroup.filter(
      (_, position) => !takenObserved.has(position),
    );
    for (let i = 0; i < unmatchedIntent.length; i += 1) {
      const record = unmatchedIntent[i] as IntentRecord;
      const match = leftoverObserved[i];
      if (match === undefined) {
        diff.missing.push({ kind: "missing", intent: record });
        continue;
      }
      diff.modified.push({
        kind: "modified",
        intent: record,
        observed: match,
        changed: changedAttributes(record, match),
      });
    }
    for (let i = unmatchedIntent.length; i < leftoverObserved.length; i += 1) {
      diff.unexpected.push({
        kind: "unexpected",
        observed: leftoverObserved[i] as ObservedDnsRecord,
      });
    }

    observedByPair.delete(key);
  }

  // Anything the provider has under a (type, name) intent never mentions.
  for (const group of observedByPair.values()) {
    for (const record of group) {
      diff.unexpected.push({ kind: "unexpected", observed: record });
    }
  }

  diff.entries = [
    ...diff.missing,
    ...diff.modified,
    ...diff.unexpected,
    ...diff.unchanged,
  ];
  return diff;
}

/**
 * The apply operations a diff implies — **excluding everything the reconciler
 * may never touch.**
 *
 * Two exclusions, both load-bearing and both asserted by tests:
 *
 * - a `modified` finding whose intent row is `owner = 'manual'` produces NO
 *   operation. Manual records are compared so a hand-edit is visible, and
 *   never rewritten;
 * - an `unexpected` record produces NO operation, ever, in any mode.
 *
 * Soft-deleted intent rows are handed in separately as `tombstones`, each
 * paired with the observed record it should remove. A tombstone with no
 * observed counterpart is already converged and produces nothing.
 */
export function applyOperationsFor(
  diff: DnsDiff,
  tombstones: ReadonlyArray<{
    intent: IntentRecord;
    observed: ObservedDnsRecord;
  }> = [],
): DnsApplyOperation[] {
  const operations: DnsApplyOperation[] = [];

  for (const entry of diff.missing) {
    if (entry.intent.owner === "manual") continue;
    operations.push({
      kind: "create",
      record: {
        type: entry.intent.type,
        name: entry.intent.name,
        content: entry.intent.content,
        ttlSeconds: entry.intent.ttlSeconds,
        priority: entry.intent.priority,
        proxied: entry.intent.proxied,
      },
    });
  }

  for (const entry of diff.modified) {
    // The escape hatch that makes the whole model usable. A reconciler that
    // rewrites a human's record is a reconciler nobody will run.
    if (entry.intent.owner === "manual") continue;
    operations.push({
      kind: "update",
      externalRecordId: entry.observed.externalRecordId,
      record: {
        type: entry.intent.type,
        name: entry.intent.name,
        content: entry.intent.content,
        ttlSeconds: entry.intent.ttlSeconds,
        priority: entry.intent.priority,
        proxied: entry.intent.proxied,
      },
    });
  }

  for (const tombstone of tombstones) {
    if (tombstone.intent.owner === "manual") continue;
    operations.push({
      kind: "delete",
      externalRecordId: tombstone.observed.externalRecordId,
      record: {
        type: tombstone.intent.type,
        name: tombstone.intent.name,
        content: tombstone.intent.content,
      },
    });
  }

  // diff.unexpected is deliberately absent. Open question 3.
  return operations;
}

/**
 * A compile-time and runtime guard: no operation list may ever be derived from
 * an `unexpected` finding. Exported so a caller that assembles operations by
 * another route can assert the same property.
 */
export function assertNoUnexpectedDeletions(
  diff: DnsDiff,
  operations: readonly DnsApplyOperation[],
): void {
  const unexpectedIds = new Set(
    diff.unexpected.map((entry) => entry.observed.externalRecordId),
  );
  for (const operation of operations) {
    if (operation.kind !== "delete") continue;
    if (unexpectedIds.has(operation.externalRecordId)) {
      throw new Error(
        "refusing to delete an unexpected provider record: open question 3 " +
          "holds this line permanently — resolve it as 'adopted' or " +
          "'dismissed', or delete it explicitly as a separate operator action",
      );
    }
  }
}

/** What a provider port must satisfy for the reconciler to drive it. */
export type ReconcileProvider = DnsProviderPort;
