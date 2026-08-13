/**
 * `provider_operations` — the outbound idempotency ledger.
 *
 * Jobs are at-least-once; some provider calls are not idempotent. Any task
 * performing a non-idempotent create — a zone, a token, a mailbox, a
 * mail-domain registration — inserts `pending` **before** the call and updates
 * after. This is what stops a worker crash mid-call from creating two zones or
 * two billable mailboxes.
 *
 * ## Open question 4, resolved PROVISIONAL: a `pending` row is NEVER auto-retried
 *
 * A `pending` row means "we may or may not have created something at the
 * provider" — the state the ledger exists to make visible and cannot itself
 * resolve. A blind retry is the one response that is always wrong: if the call
 * did go through, the retry creates a duplicate, which for a mailbox is
 * billable and for a zone is a support ticket.
 *
 * The resolution is **read-back reconciliation**: read the provider for the
 * object the operation would have created, keyed by its natural name, and
 * complete or fail the row from what is actually there. Only if that read is
 * impossible does it become an operator decision surfaced in the UI.
 *
 * ```text
 * zone create      READABLE      findZoneByName(domain) -> succeeded / failed
 * mailbox create   READABLE      milestone 2
 * TOKEN create     NOT READABLE  the value is returned exactly once, so a
 *                                pending token create resolves to "assume
 *                                created, value lost, roll it" — the one path
 *                                where a crash costs a redeployment on the
 *                                affected host. Milestone 3.
 * ```
 *
 * `response_summary` is REDACTED, and for token creation it must never contain
 * the returned value. That value goes to `application_secrets` and nowhere
 * else. This module never accepts a raw provider response — only a summary a
 * redactor already produced.
 */
import type { LoxepDb } from "@loxep/db";
import { providerOperations } from "@loxep/db/schema";
import { eq, sql } from "drizzle-orm";

export type ProviderOperationRow = typeof providerOperations.$inferSelect;

/**
 * Build the deterministic natural key a task can always recompute from its own
 * inputs. Same discipline Phase 3 requires of adapters that must derive a
 * fee's natural key when the provider supplies no id.
 */
export function idempotencyKey(
  provider: string,
  operation: string,
  subject: string,
): string {
  return `${provider}:${operation}:${subject}`;
}

export type BeginOutcome =
  /** No prior row: the caller may make the provider call. */
  | { decision: "proceed"; row: ProviderOperationRow }
  /** A prior attempt succeeded: short-circuit and reuse the summary. */
  | { decision: "already_succeeded"; row: ProviderOperationRow }
  /**
   * A prior attempt is stuck `pending`. NOT a retry signal — the caller must
   * read the provider back. `attempts` has been incremented so the ledger
   * records that somebody looked.
   */
  | { decision: "needs_read_back"; row: ProviderOperationRow };

export interface ProviderOperationsLedger {
  begin(input: {
    key: string;
    provider: string;
    operation: string;
    runId?: string | null;
  }): Promise<BeginOutcome>;
  succeed(
    key: string,
    responseSummary: Record<string, unknown> | null,
  ): Promise<ProviderOperationRow>;
  fail(
    key: string,
    responseSummary: Record<string, unknown> | null,
  ): Promise<ProviderOperationRow>;
  get(key: string): Promise<ProviderOperationRow | null>;
  /** Every operation still `pending`, for the UI's "needs a decision" list. */
  listPending(): Promise<ProviderOperationRow[]>;
}

export function createProviderOperationsLedger(options: {
  db: LoxepDb;
}): ProviderOperationsLedger {
  const { db } = options;

  async function requireRow(key: string): Promise<ProviderOperationRow> {
    const rows = await db
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.idempotencyKey, key));
    const row = rows[0];
    if (row === undefined) {
      throw new Error(`provider operation ${key} not found`);
    }
    return row;
  }

  return {
    async begin(input) {
      // One statement, so two workers racing the same key cannot both decide
      // to proceed. The insert wins for exactly one of them; the other's
      // conflict path increments `attempts` and reads the existing status.
      const inserted = await db
        .insert(providerOperations)
        .values({
          idempotencyKey: input.key,
          provider: input.provider,
          operation: input.operation,
          runId: input.runId ?? null,
        })
        .onConflictDoUpdate({
          target: providerOperations.idempotencyKey,
          set: { attempts: sql`${providerOperations.attempts} + 1` },
        })
        .returning();
      const row = inserted[0];
      if (row === undefined) {
        throw new Error("provider operation upsert returned no row");
      }

      if (row.attempts === 1 && row.status === "pending") {
        return { decision: "proceed", row };
      }
      if (row.status === "succeeded") {
        return { decision: "already_succeeded", row };
      }
      if (row.status === "failed") {
        // A previous attempt definitively did not create anything, so
        // proceeding is safe — that is the difference between `failed` and
        // `pending`, and the whole reason they are separate values.
        return { decision: "proceed", row };
      }
      return { decision: "needs_read_back", row };
    },

    async succeed(key, responseSummary) {
      await db
        .update(providerOperations)
        .set({
          status: "succeeded",
          completedAt: new Date(),
          responseSummary,
        })
        .where(eq(providerOperations.idempotencyKey, key));
      return requireRow(key);
    },

    async fail(key, responseSummary) {
      await db
        .update(providerOperations)
        .set({
          status: "failed",
          completedAt: new Date(),
          responseSummary,
        })
        .where(eq(providerOperations.idempotencyKey, key));
      return requireRow(key);
    },

    async get(key) {
      const rows = await db
        .select()
        .from(providerOperations)
        .where(eq(providerOperations.idempotencyKey, key));
      return rows[0] ?? null;
    },

    async listPending() {
      return db
        .select()
        .from(providerOperations)
        .where(eq(providerOperations.status, "pending"));
    },
  };
}
