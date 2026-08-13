/**
 * The Infrastructure worker tasks, and the transactional enqueue that makes
 * intent changes and jobs atomic.
 *
 * Milestone 1 ships two of the design's ten tasks — the two that need no
 * milestone-2/3 table:
 *
 * ```text
 * infrastructure.materialize-records  intent change      key domain:{id}:materialize
 * infrastructure.sync-records         after materialize  key domain:{id}:records
 * ```
 *
 * Deferred with their milestones, listed so the gap is visible rather than
 * forgotten: `provision-domain`, `ensure-zone`, `poll-delegation` (needs the
 * zone-create ledger path), `sync-token-policy` (milestone 3),
 * `ensure-mail-domain` / `poll-mail-ownership` / `sync-mailboxes` (milestone
 * 2), `sync-proxy-resource` (milestone 3).
 *
 * ## Two rules, both easy to violate silently
 *
 * 1. **No plaintext credential ever enters a job payload.** Graphile Worker
 *    payloads sit in a table in cleartext and survive failure. Every payload
 *    below carries a `domainId` and nothing else; the credential is resolved
 *    inside the task from the domain's connection. This is Configuration &
 *    Secrets rule 5, and the design names it as the rule this domain is most
 *    likely to break by accident, because every task here NEEDS a credential
 *    and the payload is the convenient place to put it.
 * 2. **Enqueue through the transaction handle, not a pool client.**
 *    {@link createTransactionalEnqueue} issues `graphile_worker.add_job`
 *    through whatever executor it is given, so passing a `tx` really does make
 *    the enqueue part of that transaction. Passing a pool would compile just
 *    as well and lose the guarantee, which is why there is a test that rolls
 *    back an intent change and proves no job survives.
 */
import type { LoxepDb } from "@loxep/db";
import { sql } from "drizzle-orm";
import {
  MATERIALIZE_RECORDS_TASK,
  SYNC_RECORDS_TASK,
  domainJobKey,
  type TransactionalEnqueue,
} from "./domains.ts";

export { MATERIALIZE_RECORDS_TASK, SYNC_RECORDS_TASK, domainJobKey };

/** Payload shapes. `domainId` and nothing else — see rule 1 above. */
export interface MaterializeRecordsPayload {
  domainId: string;
}
export interface SyncRecordsPayload {
  domainId: string;
  mode?: "apply" | "check";
  trigger?: "intent_change" | "sweep" | "manual" | "poll";
}

/**
 * A {@link TransactionalEnqueue} backed by `graphile_worker.add_job`, executed
 * through the caller's transaction handle.
 *
 * `@loxep/jobs`' own `addJob` takes a POOL and opens its own connection, which
 * is precisely the shape that silently loses atomicity here, so this function
 * exists rather than reusing it. The SQL signature is Graphile Worker's public
 * `add_job(identifier, payload, queue_name, run_at, max_attempts, job_key,
 * priority, flags, job_key_mode)`; only the arguments this domain uses are
 * passed by name.
 *
 * `job_key_mode` defaults to `preserve_run_at` for polling tasks so that
 * re-enqueueing a poll neither resets its backoff nor stacks duplicates. For
 * an intent-driven task `replace` is right — the newest intent wins and should
 * run now.
 */
export function createTransactionalEnqueue(): TransactionalEnqueue {
  return async (tx, taskName, payload, options) => {
    await tx.execute(sql`
      select graphile_worker.add_job(
        ${taskName},
        payload => ${JSON.stringify(payload)}::json,
        job_key => ${options?.jobKey ?? null},
        job_key_mode => ${options?.jobKeyMode ?? "replace"}
      )
    `);
  };
}

/**
 * An enqueue that records instead of enqueueing. For tests and for a
 * composition that deliberately runs without a worker.
 */
export function createRecordingEnqueue(): TransactionalEnqueue & {
  readonly calls: Array<{
    taskName: string;
    payload: Record<string, unknown>;
    jobKey: string | undefined;
  }>;
} {
  const calls: Array<{
    taskName: string;
    payload: Record<string, unknown>;
    jobKey: string | undefined;
  }> = [];
  const enqueue = (async (_tx, taskName, payload, options) => {
    calls.push({ taskName, payload, jobKey: options?.jobKey });
  }) as TransactionalEnqueue & { calls: typeof calls };
  Object.defineProperty(enqueue, "calls", { value: calls, enumerable: true });
  return enqueue;
}

/**
 * Read the jobs a transaction enqueued, for assertions. Reads the public
 * `graphile_worker.jobs` view so it works across Graphile Worker's private
 * table renames.
 */
export async function jobKeysInQueue(
  db: Pick<LoxepDb, "execute">,
  prefix: string,
): Promise<string[]> {
  const result = await db.execute<{ key: string }>(sql`
    select key from graphile_worker.jobs where key like ${`${prefix}%`}
  `);
  const rows = (result as unknown as { rows?: Array<{ key: string }> }).rows;
  return (rows ?? []).map((row) => row.key);
}
