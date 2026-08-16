/**
 * The Infrastructure worker tasks, and the transactional enqueue that makes
 * intent changes and jobs atomic.
 *
 * Milestones 1 through 3, plus Phase 8's loxep-hb7 Milestone C, ship seven of
 * the design's job-graph tasks:
 *
 * ```text
 * infrastructure.materialize-records     intent change      key domain:{id}:materialize
 * infrastructure.sync-records            after materialize  key domain:{id}:records
 * infrastructure.ensure-mail-domain      provision, mail on key domain:{id}:mail
 * infrastructure.poll-mail-ownership     GATED ON DELEGATION
 *                                                           key domain:{id}:mailverify
 * infrastructure.sync-mailboxes          after verified     key domain:{id}:mailboxes
 * infrastructure.sync-token-policy       scope change       key token:{id}:policy
 * infrastructure.reconcile-container-host intent change/poll key hosting_target:{id}:container-host
 * ```
 *
 * Deferred, listed so the gap is visible rather than forgotten:
 * `provision-domain`, `ensure-zone`, `poll-delegation` (need the zone-create
 * ledger path — milestone 1 territory, not reached yet).
 *
 * `infrastructure.sync-proxy-resource` — reserved by name and payload shape
 * below since Phase 7 milestone 3 (loxep-lmy.3) — now HAS a service behind
 * it: `proxy.ts`'s `createProxyResourcesService`, CHECK MODE ONLY (Pangolin
 * chain design milestone 2, `loxep-acj.2`). The composition root
 * (`@loxep/app`'s `infrastructure-proxy.ts`) is what finally registers the
 * executor in `registry.ts` — this package still takes no dependency on
 * `@loxep/integration-pangolin`, per `proxy-port.ts`'s own module doc.
 *
 * ## Minting a token is DELIBERATELY ABSENT from this file
 *
 * `tokens.ts`'s `mint` and `roll` are request-scoped admin actions, never
 * worker tasks — see that module's header for the HARD CONSTRAINT (ADR-0022's
 * reveal-once channel does not reach a job). Only `syncPolicy`, the
 * idempotent half, is enqueued here.
 *
 * ## `ensure-mail-domain` and `poll-mail-ownership` run the SAME function
 *
 * The design lists them separately and they are enqueued separately, with
 * different job keys, because they are triggered by different things — an
 * intent change versus a bounded poll. But both call
 * `createMailSyncService(...).runMailDomainSync(...)`, because the work is
 * identical: advance the domain as far as it currently can and record where it
 * stopped. Writing them as two code paths would produce two implementations of
 * the delegation gate, and the second one would be the wrong one.
 *
 * Their `job_key_mode` differs, and that difference is load-bearing:
 * `ensure-mail-domain` uses the default `replace` (the newest intent wins and
 * should run now), while `poll-mail-ownership` must use `preserve_run_at` so
 * re-enqueueing a poll neither resets its backoff nor stacks duplicates during
 * a delegation wait that can last days.
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
export {
  ENSURE_MAIL_DOMAIN_TASK,
  POLL_MAIL_OWNERSHIP_TASK,
  SYNC_MAILBOXES_TASK,
} from "./mail.ts";
export {
  SYNC_TOKEN_POLICY_TASK,
  SYNC_TOKEN_POLICY_RUN_KIND,
  tokenJobKey,
} from "./tokens.ts";

/**
 * The design's job graph names this task with key `domain:{id}:proxy` —
 * triggered by a HOSTING change (a domain's apex target, or a target's
 * `proxy_connection_id`/`external_site_id`), not a token scope change.
 * `domainJobKey(SYNC_PROXY_RESOURCE_TASK, domainId)` produces it, exactly the
 * way `MATERIALIZE_RECORDS_TASK`/`SYNC_RECORDS_TASK` reuse the same helper.
 *
 * `mode`/`trigger` follow `SyncRecordsPayload`'s two-field shape, but `mode`
 * is enforced `'check'` by `proxy.ts`'s service regardless of what a caller
 * passes — see that module's "CHECK MODE ONLY" section. The field stays on
 * the payload (rather than being narrowed out of the type) so a later
 * write milestone does not need to touch this shape again.
 */
export const SYNC_PROXY_RESOURCE_TASK = "infrastructure.sync-proxy-resource";
export interface SyncProxyResourcePayload {
  domainId: string;
}

/**
 * The template engine's ONE driver task (Pangolin chain design milestone 6,
 * `loxep-acj.6`) — `provisioning.ts`'s `runProvisioningTemplate`'s worker
 * wrapper. Payload is `{ runId }` and NOTHING else — rule 1 above applies
 * here exactly as everywhere else: no connection id, no credential, ever.
 * Every credential this run needs is resolved INSIDE the task from the
 * frozen `compiled_plan`'s own step params (a `dnsConnectionId`, a
 * `mailConnectionId`, a `hostingTargetId`) plus the connections those
 * reference.
 *
 * `job_key_mode: 'preserve_run_at'` is load-bearing, not a default left in
 * place: a template run legitimately waits DAYS for DNS delegation (the same
 * wait `POLL_MAIL_OWNERSHIP_TASK` already has to survive), and re-enqueueing
 * it — at run start, and again on every operator "Resume run" click — must
 * neither reset its backoff nor stack a second pending job behind the first.
 * `provisioningTemplateRunJobKey(runId)` is the one job key a run ever uses,
 * for its entire lifetime.
 *
 * The body is `mail-sync.ts`'s shape, generalized to seven step kinds and
 * three providers: advance as far as the run currently can, record exactly
 * where it stopped, return. Running it again — a resume — picks up from
 * wherever reality now is; a step already `'succeeded'` is skipped by its own
 * `template_run_steps` row, and any step that made a non-idempotent provider
 * create is protected a second time by `provider_operations`, exactly as
 * every other reconciler in this file already is.
 */
export const RUN_PROVISIONING_TEMPLATE_TASK =
  "infrastructure.run-provisioning-template";
export interface RunProvisioningTemplatePayload {
  runId: string;
}

/** The one job key a template run ever uses — `template_run:{id}`, for its whole lifetime, across every resume. */
export function provisioningTemplateRunJobKey(runId: string): string {
  return `template_run:${runId}`;
}

/**
 * loxep-hb7 Milestone C: the container-host reconciler. UNLIKE
 * `SYNC_PROXY_RESOURCE_TASK` above, this one IS registered — the service it
 * belongs to (`container-hosts.ts`) exists, and so does the port
 * implementation (`@loxep/app`'s `containerHostPortFromDockhandAdapter`,
 * already wired against a real `@loxep/integration-dockhand` adapter).
 *
 * `hostingTargetId` and nothing else — rule 1 above applies here exactly as
 * it does to every other task in this file: the Dockhand connection id, the
 * TLS material, and the Hawser token all live in
 * `external_resources`/`resource_links`/`application_secrets` and are
 * resolved INSIDE the task from `hostingTargetId` alone.
 *
 * `mode`/`trigger` follow `SyncRecordsPayload`'s own two-field shape exactly
 * — `'intent_change'` for the create dialog / registration panel submitting
 * new desired state, `'manual'` for an operator's Reconcile/Check-now
 * button, `'poll'` for Milestone D's drift cadence. `'sweep'` is deliberately
 * absent: there is no cross-connection sweep of this task, only the
 * per-subject drift cadence — see `container-hosts.ts`'s module doc.
 */
export const RECONCILE_CONTAINER_HOST_TASK =
  "infrastructure.reconcile-container-host";
export interface ReconcileContainerHostPayload {
  hostingTargetId: string;
  mode?: "apply" | "check";
  trigger?: "intent_change" | "manual" | "poll";
  /** Structurally a Graphile Worker jsonb payload — see `createTransactionalEnqueue`'s `Record<string, unknown>` parameter. */
  [key: string]: unknown;
}

/**
 * The design's job graph key format for this task: `hosting_target:{id}:
 * container-host`, mirroring {@link domainJobKey}'s `domain:{id}` shape and
 * {@link tokenJobKey}'s `token:{id}` shape in `tokens.ts`. One job per
 * TARGET, never per connection — see `container-hosts.ts`'s module doc for
 * why a per-connection key would let two targets on the same Dockhand
 * instance clobber each other's pending job.
 */
export function containerHostJobKey(
  taskName: string,
  hostingTargetId: string,
): string {
  return `${taskName}:hosting_target:${hostingTargetId}`;
}

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
 * Mail payloads carry a `domainId` and NOTHING else — not the mail connection
 * id, not the ownership code, and emphatically not a mailbox password. Rule 1
 * above is at its sharpest here: `sync-mailboxes` is the one task in this
 * domain that handles a minted credential, and Graphile Worker payloads sit in
 * a table in cleartext and survive failure. The password is minted INSIDE the
 * task, written straight to `application_secrets`, and never serialized
 * anywhere else. `test/mail-boundary.test.ts` asserts it.
 */
export interface EnsureMailDomainPayload {
  domainId: string;
}
export interface PollMailOwnershipPayload {
  domainId: string;
}
export interface SyncMailboxesPayload {
  domainId: string;
}
/**
 * `tokenId` and nothing else — the credential itself is never in this
 * payload. `syncPolicy` resolves the token's provider connection and zone
 * scope from the database inside the task.
 */
export interface SyncTokenPolicyPayload {
  tokenId: string;
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
