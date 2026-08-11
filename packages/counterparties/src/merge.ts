/**
 * Merge: a survivor pointer, never a rewrite.
 *
 * ## The rule
 *
 * ```text
 * counterparties.merged_into_counterparty_id  ->  the survivor
 * ```
 *
 * Mark the loser, never delete it, and never rewrite the foreign keys on
 * history. Every read model resolves through the pointer
 * (`coalesce(merged_into_counterparty_id, id)`) and excludes merged rows from
 * pickers.
 *
 * The alternative — reassign every reference to the survivor and delete the
 * loser — is what most systems do, and it is wrong here for three compounding
 * reasons: it destroys the evidence of what was matched (which is exactly the
 * information you need when the merge turns out to be wrong), it makes unmerge
 * a reconstruction exercise instead of a one-column update, and it contradicts
 * a precedent already set twice — Phase 3 marks a cross-connection duplicate
 * with `orders.duplicate_of_order_id` and excludes it in reporting rather than
 * deleting the row, and Phase 5 corrects a ledger by reversing rather than
 * mutating. Evidence is never destroyed to make a report tidier.
 *
 * The cost is real and worth stating: **every counterparty read path must
 * resolve the pointer, and one that forgets will under-count.** The three
 * mitigations are all implemented here: the resolution lives in ONE function
 * ({@link createMergeService}'s `resolve`), merged rows are excluded from every
 * picker so new references cannot accumulate on a loser, and
 * `referencesToMergedRows` is the named report that makes a forgotten path
 * visible.
 *
 * ## Merges are never automatic
 *
 * `dedupe.ts` produces candidates; a human merges. Same posture Phase 5 took
 * for reconciliation, and for the same reason.
 *
 * ## Depth: the one place this diverges from the sketch
 *
 * The design states the resolution formula as
 * `coalesce(merged_into_counterparty_id, id)` — a SINGLE hop. That formula is
 * only correct while the pointer graph is at most one level deep, and nothing
 * in the DDL guarantees it: `A -> B` followed by `B -> C` leaves `A` resolving
 * to `B`, which is itself merged, and every read using the documented formula
 * silently under-counts `C`.
 *
 * Two ways to keep the formula true. This implementation uses both, belt and
 * braces, because they defend different failures:
 *
 * 1. **Refusal.** Merging a row that is already merged (a double merge) and
 *    merging INTO a row that is already merged are both refused outright. That
 *    also makes a cycle unconstructible: `A -> B` then `B -> A` fails on the
 *    second step because the target `A` is merged. The self-merge `A -> A` is
 *    refused by the database as well (`counterparties_self_merge_check`).
 * 2. **Compression.** When `C` is merged into `D`, any row already pointing at
 *    `C` is re-pointed to `D` inside the same transaction. Under rule 1 this
 *    can only happen when `C` is a survivor rather than a loser, which is the
 *    legitimate case rule 1 does not cover.
 *
 * Compression has one honest cost, recorded because it is the kind of thing
 * that surprises a reviewer later: after `A -> C` and then `C -> D`, row `A`
 * stores `D` and no longer stores that it was once merged into `C`. The
 * evidence is not lost — the compression writes an `audit_events` row carrying
 * the before and after pointer for every row it moves — but it lives in the
 * audit trail rather than the column. Unmerging `C` therefore restores `C` and
 * leaves `A` pointing at `D`; re-attaching `A` to `C` is a second, explicit
 * act. The alternative (a recursive resolver over an arbitrarily deep chain)
 * keeps the column exact and makes every read path a recursive CTE, which is
 * precisely the "one function every read path uses" that the design wants to
 * stay cheap.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { CounterpartyMergeError, CounterpartyNotFoundError } from "./errors.ts";
import { textLiteral, uuidList, uuidLiteral } from "./sql.ts";

/**
 * The single resolution expression, as SQL, for use inside other read models.
 *
 * Exported as a string so that every query in this package (and any future
 * consumer) resolves identically. `alias` is the table alias the caller used.
 */
export function resolvedIdExpression(alias = "c"): string {
  return `coalesce(${alias}.merged_into_counterparty_id, ${alias}.id)`;
}

/**
 * The picker predicate, stated once.
 *
 * A merged row must never appear in a selector, because a new reference
 * accumulating on a loser is the one way this model degrades. `archived` is
 * excluded for the reason the status exists — "hide from every picker" — while
 * `inactive` is NOT: "we no longer do business with them" is still a party you
 * might record a historical fact against.
 */
export function pickerPredicate(alias = "c"): string {
  return `${alias}.merged_into_counterparty_id is null and ${alias}.status <> 'archived'`;
}

export interface MergeInput {
  /** The row that stops being used. */
  counterpartyId: string;
  /** The row that survives and that reads resolve to. */
  survivorId: string;
  /** Recorded on the audit event; merges are a human judgement. */
  reason?: string;
  actorUserId?: string | null;
  requestId?: string | null;
}

export interface MergeResult {
  counterpartyId: string;
  survivorId: string;
  /** Rows whose pointer was compressed onto the new survivor. */
  compressed: string[];
}

export interface MergeService {
  /**
   * **The** resolver. Every read path in this package goes through it or
   * through {@link resolvedIdExpression}.
   *
   * Returns the id unchanged when the row is not merged, so callers never need
   * to branch on whether a merge happened.
   */
  resolve: (counterpartyId: string) => Promise<string>;
  /** Batch form of {@link MergeService.resolve}, preserving input order. */
  resolveMany: (counterpartyIds: readonly string[]) => Promise<string[]>;
  merge: (input: MergeInput) => Promise<MergeResult>;
  /** Clears one column, exactly as the design promises. */
  unmerge: (input: {
    counterpartyId: string;
    actorUserId?: string | null;
    requestId?: string | null;
  }) => Promise<{ counterpartyId: string; previousSurvivorId: string }>;
  /** Every row currently pointing at `counterpartyId`. */
  losersOf: (counterpartyId: string) => Promise<string[]>;
  /**
   * The named report the design asks for: rows that still point at a merged
   * counterparty.
   *
   * Under the refusal rule above this should always be empty, which is exactly
   * why it is worth running — a non-empty result means something wrote
   * `merged_into_counterparty_id` without going through this service.
   */
  referencesToMergedRows: () => Promise<
    { counterpartyId: string; pointsAt: string; pointsAtIsMerged: boolean }[]
  >;
}

export function createMergeService(options: { db: LoxepDb }): MergeService {
  const { db } = options;

  type MergeState = {
    id: string;
    referenceCode: string;
    displayName: string;
    mergedInto: string | null;
  };

  async function loadState(
    executor: Pick<LoxepDb, "execute">,
    counterpartyId: string,
  ): Promise<MergeState> {
    const result = await executor.execute(
      `select id::text as id, reference_code, display_name,
              merged_into_counterparty_id::text as merged_into
         from counterparties where id = ${uuidLiteral(counterpartyId)}`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new CounterpartyNotFoundError(
        `unknown counterparty "${counterpartyId}"`,
      );
    }
    return {
      id: row["id"] as string,
      referenceCode: row["reference_code"] as string,
      displayName: row["display_name"] as string,
      mergedInto: (row["merged_into"] as string | null) ?? null,
    };
  }

  return {
    resolve: async (counterpartyId) => {
      const state = await loadState(db, counterpartyId);
      return state.mergedInto ?? state.id;
    },

    resolveMany: async (counterpartyIds) => {
      if (counterpartyIds.length === 0) return [];
      const result = await db.execute(
        `select c.id::text as id, ${resolvedIdExpression("c")}::text as resolved
           from counterparties c
          where c.id in (${uuidList(counterpartyIds)})`,
      );
      const byId = new Map(
        result.rows.map((row) => [
          row["id"] as string,
          row["resolved"] as string,
        ]),
      );
      return counterpartyIds.map((id) => {
        const resolved = byId.get(id);
        if (resolved === undefined) {
          throw new CounterpartyNotFoundError(`unknown counterparty "${id}"`);
        }
        return resolved;
      });
    },

    merge: async (input) => {
      if (input.counterpartyId === input.survivorId) {
        throw new CounterpartyMergeError(
          "a counterparty cannot be merged into itself " +
            "(counterparties_self_merge_check)",
        );
      }
      return db.transaction(async (tx) => {
        const loser = await loadState(tx, input.counterpartyId);
        const survivor = await loadState(tx, input.survivorId);

        if (loser.mergedInto !== null) {
          throw new CounterpartyMergeError(
            `counterparty "${loser.referenceCode}" is already merged into ` +
              `"${loser.mergedInto}": a second merge would build a pointer ` +
              "chain that the documented single-hop resolution cannot follow. " +
              "Unmerge it first if the original merge was wrong.",
          );
        }
        if (survivor.mergedInto !== null) {
          throw new CounterpartyMergeError(
            `cannot merge into counterparty "${survivor.referenceCode}": it is ` +
              `itself merged into "${survivor.mergedInto}". Merge into the ` +
              "surviving row instead. (This is also what makes a merge cycle " +
              "unconstructible.)",
          );
        }

        // Compression: rows that already point at the loser follow it, so the
        // pointer graph stays exactly one level deep and the design's
        // `coalesce(merged_into_counterparty_id, id)` formula stays true.
        const compressed = await tx.execute(
          `update counterparties
              set merged_into_counterparty_id = ${uuidLiteral(survivor.id)},
                  updated_at = now()
            where merged_into_counterparty_id = ${uuidLiteral(loser.id)}
          returning id::text as id`,
        );
        const compressedIds = compressed.rows.map((row) => row["id"] as string);

        await tx.execute(
          `update counterparties
              set merged_into_counterparty_id = ${uuidLiteral(survivor.id)},
                  merged_at = now(),
                  merged_by_user_id = ${
                    input.actorUserId === undefined ||
                    input.actorUserId === null
                      ? "null"
                      : textLiteral(input.actorUserId)
                  },
                  updated_at = now()
            where id = ${uuidLiteral(loser.id)}`,
        );

        const audit = createAuditService({ db: tx });
        await audit.append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.merged",
          resourceType: "counterparty",
          resourceId: loser.id,
          before: { mergedIntoCounterpartyId: null },
          after: { mergedIntoCounterpartyId: survivor.id },
          requestId: input.requestId ?? null,
          metadata: {
            reason: input.reason ?? null,
            loserReferenceCode: loser.referenceCode,
            survivorReferenceCode: survivor.referenceCode,
            compressedCount: compressedIds.length,
          },
        });
        for (const id of compressedIds) {
          // One event per moved row: the column now stores the new survivor,
          // so the audit trail is where "used to point at the loser" survives.
          await audit.append({
            actorUserId: input.actorUserId ?? null,
            action: "counterparty.merge_pointer_compressed",
            resourceType: "counterparty",
            resourceId: id,
            before: { mergedIntoCounterpartyId: loser.id },
            after: { mergedIntoCounterpartyId: survivor.id },
            requestId: input.requestId ?? null,
            metadata: { survivorReferenceCode: survivor.referenceCode },
          });
        }

        return {
          counterpartyId: loser.id,
          survivorId: survivor.id,
          compressed: compressedIds,
        };
      });
    },

    unmerge: async (input) =>
      db.transaction(async (tx) => {
        const state = await loadState(tx, input.counterpartyId);
        if (state.mergedInto === null) {
          throw new CounterpartyMergeError(
            `counterparty "${state.referenceCode}" is not merged`,
          );
        }
        // One column — three, strictly, because `merged_at` is CHECK-tied to
        // the pointer and the actor stamp belongs to the act that is being
        // undone. There is no history to reconstruct, which is the whole point
        // of the survivor-pointer posture.
        await tx.execute(
          `update counterparties
              set merged_into_counterparty_id = null,
                  merged_at = null,
                  merged_by_user_id = null,
                  updated_at = now()
            where id = ${uuidLiteral(state.id)}`,
        );
        await createAuditService({ db: tx }).append({
          actorUserId: input.actorUserId ?? null,
          action: "counterparty.unmerged",
          resourceType: "counterparty",
          resourceId: state.id,
          before: { mergedIntoCounterpartyId: state.mergedInto },
          after: { mergedIntoCounterpartyId: null },
          requestId: input.requestId ?? null,
          metadata: { referenceCode: state.referenceCode },
        });
        return {
          counterpartyId: state.id,
          previousSurvivorId: state.mergedInto,
        };
      }),

    losersOf: async (counterpartyId) => {
      const result = await db.execute(
        `select id::text as id from counterparties
          where merged_into_counterparty_id = ${uuidLiteral(counterpartyId)}
          order by merged_at, id`,
      );
      return result.rows.map((row) => row["id"] as string);
    },

    referencesToMergedRows: async () => {
      const result = await db.execute(
        `select c.id::text as id,
                c.merged_into_counterparty_id::text as points_at,
                (s.merged_into_counterparty_id is not null) as target_merged
           from counterparties c
           join counterparties s on s.id = c.merged_into_counterparty_id
          where s.merged_into_counterparty_id is not null
          order by c.id`,
      );
      return result.rows.map((row) => ({
        counterpartyId: row["id"] as string,
        pointsAt: row["points_at"] as string,
        pointsAtIsMerged: row["target_merged"] as boolean,
      }));
    },
  };
}
