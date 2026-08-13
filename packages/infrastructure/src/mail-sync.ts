/**
 * The mail reconciler: register the domain, prove ownership, converge the
 * mailboxes — **as a resumable desired-state loop, never as a linear script**
 * (Phase 7 milestone 2, loxep-lmy.2).
 *
 * ## Why this cannot be a script, stated once and built around
 *
 * Mail provisioning has a step in the middle that takes **days and is performed
 * by a human at a registrar**. Nameserver delegation is not something Loxep can
 * wait on, retry into existence, or work around, and the mail provider's
 * ownership check cannot succeed until it completes — the ownership proof is a
 * TXT record the provider resolves from the *public* DNS, which still answers
 * from the old nameservers until delegation lands.
 *
 * A script would therefore have to block, poll in-process, or fail. The
 * reconciler's answer is that all three are wrong and none is necessary:
 * {@link MailSyncService.runMailDomainSync} advances the domain **as far as it
 * currently can**, records exactly where it stopped, and returns. Run it again
 * in an hour, a day, or a week and it picks up from wherever reality now is.
 * Every run is safe, every run is idempotent, and no run is "the one that has
 * to work".
 *
 * ```text
 * fetch ownership code      account-level read; NOT gated — the TXT has to
 *                           exist before delegation matters
 *          |
 * publish records           materialize + sync-records (milestone 1's path)
 *          |
 * ==== THE DELEGATION GATE ==============================================
 * register at provider      NEVER attempted until the DNS provider reports
 *                           the zone active
 *          |
 * verify ownership          read the domain back; absent means "not yet"
 *          |
 * check the provider's DNS  passesMx / passesSpf / passesDkim / passesDmarc
 *          |
 * sync mailboxes            create what intent describes, ledgered
 * ```
 *
 * ## The delegation gate is the single most valuable ordering constraint
 *
 * The design says so directly, and {@link isDelegationConfirmed} is where it
 * lives:
 *
 * > Mail ownership verification cannot succeed while the registrar still
 * > delegates elsewhere, and every failed attempt may count against a
 * > provider's rate limits and its own patience. Do not attempt verification
 * > until the DNS provider reports the zone active. That one rule prevents most
 * > of the flakiness this workflow would otherwise exhibit.
 *
 * A gated run makes **no provider call at all** for registration. It is not a
 * failure, it does not increment `verify_attempts`, it does not touch
 * `consecutive_errors`, and the run finishes `succeeded` — because "correctly
 * waited" is a success. Recording it as an error would light up every health
 * indicator in the product for the entirely normal condition of a domain whose
 * nameservers were changed twenty minutes ago.
 *
 * ## Registration failure after the gate is ALSO not an error
 *
 * Delegation being confirmed at the DNS provider does not mean the ownership
 * TXT has propagated to whatever resolver the mail provider uses. So a rejected
 * `addDomain` is classified rather than thrown:
 *
 * ```text
 * invalid_request / not_found   the provider looked and was not satisfied.
 *                               Expected. verify_attempts += 1, the message is
 *                               recorded, the run is `partial`, and the next
 *                               poll tries again.
 * auth / rate_limited /         a real fault. The run FAILS, connection health
 *   provider_unavailable        is updated, and the error propagates so the
 *                               job's backoff applies.
 * ```
 *
 * Collapsing those two into "the call failed" is what produces a workflow that
 * looks broken for three days and then works.
 *
 * ## Two non-idempotent creates, both ledgered, both read-back-resolvable
 *
 * `addDomain` and `createUser` go through `provider_operations` — insert
 * `pending` BEFORE the call, resolve after. A `pending` row is never blindly
 * retried (open question 4): it is resolved by READING the provider back, which
 * for both of these is possible (`findDomainByName`, `listUsers`). A mailbox
 * create is **billable**, which is the case that argument was written for.
 *
 * ## What this reconciler will not do
 *
 * **It never deletes a mailbox it did not know about.** A provider address
 * absent from intent is reported as an unexpected finding and left alone — the
 * same rule milestone 1 applies to unexpected DNS records, with considerably
 * higher stakes, because deleting a mailbox takes the mail with it. Loxep
 * deletes exactly one thing: a mailbox an operator explicitly soft-deleted.
 */
import type { LoxepDb } from "@loxep/db";
import {
  mailDomains,
  mailboxes,
  managedDomains,
  reconcileRunSteps,
  reconcileRuns,
} from "@loxep/db/schema";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { domainJobKey, MATERIALIZE_RECORDS_TASK } from "./domains.ts";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
} from "./errors.ts";
import type { TransactionalEnqueue } from "./domains.ts";
import type {
  MailProviderPort,
  MailboxSecretWriter,
  PasswordMinter,
} from "./mail-port.ts";
import {
  createProviderOperationsLedger,
  idempotencyKey,
  type ProviderOperationsLedger,
} from "./operations.ts";
import type { ResponseRedactor } from "./port.ts";

export type MailDomainRow = typeof mailDomains.$inferSelect;
export type ManagedDomainRow = typeof managedDomains.$inferSelect;

/** `reconcile_runs.kind` values this module writes. */
export const MAIL_DOMAIN_RUN_KIND = "sync-mail-domain";
export const MAILBOX_RUN_KIND = "sync-mailboxes";

/**
 * How far a mail-domain run got. Every value except `failed` is a **successful**
 * run — the loop is supposed to stop partway, repeatedly, for days.
 */
export type MailDomainOutcome =
  /** `mail_enabled` is false. Nothing to do, and not an error. */
  | "disabled"
  /** Correctly waiting for the registrar. NO provider call was made. */
  | "delegation_pending"
  /** The provider looked and was not yet satisfied. Try again later. */
  | "ownership_pending"
  /** Registered and verified; the provider's DNS checks do not all pass yet. */
  | "dns_pending"
  /** Registered, verified, all four DNS checks pass. */
  | "verified";

export interface MailDomainSyncResult {
  runId: string;
  status: "succeeded" | "failed" | "partial";
  outcome: MailDomainOutcome;
  /** Whether the ownership code was fetched during this run. */
  ownershipCodeFetched: boolean;
  /** The provider's DNS verdict, when it was read this run. */
  dns: {
    passesMx: boolean;
    passesSpf: boolean;
    passesDkim: boolean;
    passesDmarc: boolean;
  } | null;
  verifyAttempts: number;
}

export interface MailboxSyncResult {
  runId: string;
  status: "succeeded" | "failed" | "partial";
  created: number;
  routingRulesCreated: number;
  deleted: number;
  unchanged: number;
  /** Provider addresses intent does not describe. REPORTED, never deleted. */
  unexpected: string[];
}

export interface RunMailSyncInput {
  domainId: string;
  trigger: "intent_change" | "sweep" | "manual" | "poll";
  actorUserId?: string | null;
  /** Defaults to a pass-through that keeps only scalar fields. */
  redact?: ResponseRedactor;
}

const defaultRedactor: ResponseRedactor = (value) => {
  if (typeof value !== "object" || value === null) return { value: null };
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null
    ) {
      out[key] = entry;
    }
  }
  return out;
};

/**
 * **The delegation gate.**
 *
 * Delegation is confirmed when the DNS provider says so — never when a
 * registrar form was submitted, and never on a timer. Two signals count,
 * because milestone 1 shipped both columns and milestone 3's `poll-delegation`
 * will write both:
 *
 * - `delegation_verified_at` — Loxep's own record that it observed delegation;
 * - `provider_zone_status === 'active'` — the DNS provider's verbatim status
 *   string, which for Cloudflare means the zone is answering for the name.
 *
 * Either is sufficient and neither is inferred from `state`, deliberately:
 * `state` is Loxep's interpretation and these two are evidence, and a gate this
 * consequential should read the evidence.
 *
 * Exported and tested directly, because it is one boolean whose being wrong
 * costs days of confusing behavior.
 */
export function isDelegationConfirmed(domain: {
  delegationVerifiedAt: Date | null;
  providerZoneStatus: string | null;
}): boolean {
  if (domain.delegationVerifiedAt !== null) return true;
  return domain.providerZoneStatus === "active";
}

/**
 * The error kinds that mean "the provider is not yet satisfied" rather than
 * "something is broken". See the module doc — collapsing these into failure is
 * what makes the workflow look broken for three days.
 */
function isOwnershipNotYetProvable(kind: string): boolean {
  return kind === "invalid_request" || kind === "not_found";
}

function errorKind(error: unknown): string {
  return error instanceof Error && "kind" in error
    ? String((error as { kind: unknown }).kind)
    : "provider_unavailable";
}

/**
 * The default password minter: 32 bytes of CSPRNG entropy, base64url.
 *
 * Base64url rather than a "pronounceable" or character-class-mixed generator on
 * purpose. This value is typed into a mail client once, never remembered, and
 * every scheme that makes a password nicer to type makes it weaker. The
 * composition root may inject its own.
 */
export const defaultPasswordMinter: PasswordMinter = () =>
  randomBytes(32).toString("base64url");

/** The provisioning chain, for monotonic state advancement. */
const STATE_ORDER = [
  "draft",
  "zone_created",
  "awaiting_delegation",
  "zone_active",
  "records_synced",
  "mail_pending",
  "ready",
] as const;

/**
 * Advance `state` only forwards, never backwards.
 *
 * `state` only ever advances (the design's rule, and why `degraded` is not a
 * state). A mail run that finds a `ready` domain temporarily failing its DKIM
 * check must not walk it back to `mail_pending`: health is orthogonal and lives
 * in `last_error_*` / `drift_detected_at`. Returns `null` when no write is
 * warranted.
 */
export function nextState(
  current: string,
  target: (typeof STATE_ORDER)[number],
): string | null {
  const currentIndex = STATE_ORDER.indexOf(
    current as (typeof STATE_ORDER)[number],
  );
  const targetIndex = STATE_ORDER.indexOf(target);
  if (currentIndex < 0 || targetIndex <= currentIndex) return null;
  return target;
}

export interface MailSyncService {
  /**
   * Advance one domain's mail state as far as it currently can — the design's
   * `ensure-mail-domain` and `poll-mail-ownership` tasks are the same resumable
   * function called with a different trigger, because they are the same work.
   */
  runMailDomainSync(input: RunMailSyncInput): Promise<MailDomainSyncResult>;
  /** Converge the domain's mailboxes with the provider. */
  runMailboxSync(input: RunMailSyncInput): Promise<MailboxSyncResult>;
}

export interface CreateMailSyncServiceOptions {
  db: LoxepDb;
  provider: MailProviderPort;
  /** Where a minted mailbox password is stored. WRITE-ONLY (see mail-port.ts). */
  secrets: MailboxSecretWriter;
  /** Defaults to {@link defaultPasswordMinter}. */
  mintPassword?: PasswordMinter;
  /**
   * `provider_operations.provider`, e.g. `purelymail`. Defaults to `mail`; the
   * composition root passes the real provider name so two mail providers cannot
   * collide on one idempotency key.
   */
  providerName?: string;
  /** Enqueues a re-materialize once the ownership code exists. */
  enqueue?: TransactionalEnqueue;
  ledger?: ProviderOperationsLedger;
}

export function createMailSyncService(
  options: CreateMailSyncServiceOptions,
): MailSyncService {
  const { db, provider, secrets } = options;
  const mintPassword = options.mintPassword ?? defaultPasswordMinter;
  const providerName = options.providerName ?? "mail";
  const enqueue: TransactionalEnqueue =
    options.enqueue ?? (async () => undefined);
  const ledger = options.ledger ?? createProviderOperationsLedger({ db });

  async function loadDomain(domainId: string): Promise<{
    domain: ManagedDomainRow;
    mail: MailDomainRow;
  }> {
    const domainRows = await db
      .select()
      .from(managedDomains)
      .where(eq(managedDomains.id, domainId));
    const domain = domainRows[0];
    if (domain === undefined) {
      throw new InfrastructureNotFoundError(
        `managed domain ${domainId} not found`,
        { domainId },
      );
    }
    const mailRows = await db
      .select()
      .from(mailDomains)
      .where(eq(mailDomains.domainId, domainId));
    const mail = mailRows[0];
    if (mail === undefined) {
      throw new InfrastructureNotFoundError(
        `managed domain "${domain.name}" has no mail registration; enable mail before reconciling it`,
        { domainId },
      );
    }
    return { domain, mail };
  }

  /** One run row plus its step recorder, shared by both entry points. */
  async function openRun(
    kind: string,
    input: RunMailSyncInput,
    subjectId: string,
  ): Promise<{
    runId: string;
    step: (entry: {
      step: string;
      status: "succeeded" | "failed" | "skipped";
      requestSummary?: Record<string, unknown> | null;
      responseSummary?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorDetail?: string | null;
    }) => Promise<void>;
    finish: (
      status: "succeeded" | "failed" | "partial",
      errorSummary: string | null,
    ) => Promise<void>;
  }> {
    const runRows = await db
      .insert(reconcileRuns)
      .values({
        kind,
        subjectType: "domain",
        subjectId,
        // Mail work is never a comparison: there is no read-only form of
        // "register this domain". `check` would have nothing to report.
        mode: "apply",
        trigger: input.trigger,
        actorUserId: input.actorUserId ?? null,
      })
      .returning();
    const run = runRows[0];
    if (run === undefined) throw new Error("reconcile run insert returned no row");

    let sequence = 0;
    return {
      runId: run.id,
      async step(entry) {
        await db.insert(reconcileRunSteps).values({
          runId: run.id,
          sequence: sequence++,
          step: entry.step,
          status: entry.status,
          provider: "mail",
          requestSummary: entry.requestSummary ?? null,
          responseSummary: entry.responseSummary ?? null,
          errorCode: entry.errorCode ?? null,
          errorDetail: entry.errorDetail ?? null,
        });
      },
      async finish(status, errorSummary) {
        await db
          .update(reconcileRuns)
          .set({
            status,
            finishedAt: new Date(),
            stepCount: sequence,
            errorSummary,
          })
          .where(eq(reconcileRuns.id, run.id));
      },
    };
  }

  async function recordProviderFailure(
    domain: ManagedDomainRow,
    kind: string,
  ): Promise<void> {
    await db
      .update(managedDomains)
      .set({
        lastErrorAt: new Date(),
        lastErrorCode: kind,
        consecutiveErrors: domain.consecutiveErrors + 1,
        updatedAt: new Date(),
      })
      .where(eq(managedDomains.id, domain.id));
  }

  async function clearProviderFailure(domainId: string): Promise<void> {
    await db
      .update(managedDomains)
      .set({
        lastErrorAt: null,
        lastErrorCode: null,
        consecutiveErrors: 0,
        updatedAt: new Date(),
      })
      .where(eq(managedDomains.id, domainId));
  }

  async function advanceState(
    domain: ManagedDomainRow,
    target: (typeof STATE_ORDER)[number],
  ): Promise<void> {
    const next = nextState(domain.state, target);
    if (next === null) return;
    await db
      .update(managedDomains)
      .set({ state: next, updatedAt: new Date() })
      .where(eq(managedDomains.id, domain.id));
  }

  return {
    async runMailDomainSync(input) {
      const redact = input.redact ?? defaultRedactor;
      const { domain, mail } = await loadDomain(input.domainId);
      const run = await openRun(MAIL_DOMAIN_RUN_KIND, input, domain.id);

      let ownershipCode = mail.ownershipCode;
      let ownershipCodeFetched = false;
      let providerAddedAt = mail.providerAddedAt;
      let ownershipVerifiedAt = mail.ownershipVerifiedAt;
      let verifyAttempts = mail.verifyAttempts;

      const recordVerifyAttempt = async (
        errorSummary: string | null,
      ): Promise<void> => {
        verifyAttempts += 1;
        await db
          .update(mailDomains)
          .set({
            verifyAttempts,
            lastVerifyAt: new Date(),
            lastVerifyError: errorSummary,
            updatedAt: new Date(),
          })
          .where(eq(mailDomains.domainId, domain.id));
      };

      try {
        await run.step({
          step: "read-intent",
          status: "succeeded",
          responseSummary: {
            domain: domain.name,
            mailEnabled: domain.mailEnabled,
            hasOwnershipCode: ownershipCode !== null,
            registered: providerAddedAt !== null,
            ownershipVerified: ownershipVerifiedAt !== null,
            verifyAttempts,
          },
        });

        if (!domain.mailEnabled) {
          // Intent says no mail. Not an error, and emphatically not a reason to
          // deregister the domain at the provider — that is a destructive act
          // an operator performs explicitly.
          await run.step({ step: "mail-disabled", status: "skipped" });
          await run.finish("succeeded", null);
          return {
            runId: run.runId,
            status: "succeeded",
            outcome: "disabled",
            ownershipCodeFetched: false,
            dns: null,
            verifyAttempts,
          };
        }

        /* ---- 1. the ownership code, UNGATED ---------------------------- */
        // Deliberately before the delegation gate: this is an account-level
        // read at the MAIL provider that says nothing about DNS, and the TXT
        // record it produces has to be published and propagating BEFORE
        // delegation completes for the rest of the flow to be quick.
        if (ownershipCode === null) {
          try {
            ownershipCode = await provider.getOwnershipCode();
          } catch (error) {
            const kind = errorKind(error);
            await run.step({
              step: "fetch-ownership-code",
              status: "failed",
              errorCode: kind,
              errorDetail: "could not fetch the mail provider's ownership code",
            });
            await run.finish("failed", `ownership code fetch failed (${kind})`);
            await recordProviderFailure(domain, kind);
            throw new ProviderCallError(kind, "ownership code fetch failed", {
              domainId: domain.id,
              runId: run.runId,
            });
          }
          ownershipCodeFetched = true;
          await db
            .update(mailDomains)
            .set({ ownershipCode, updatedAt: new Date() })
            .where(eq(mailDomains.domainId, domain.id));

          await run.step({
            step: "fetch-ownership-code",
            status: "succeeded",
            requestSummary: { operation: "mail.domain.ownershipCode" },
            // NOT redacted away: the code's whole purpose is to be published in
            // a public TXT record. The design says so explicitly so the
            // argument is not had twice.
            responseSummary: {
              ownershipCode,
              ownershipCodeIsPublic: true,
            },
          });

          // The code changes the desired record set, so the materializer has to
          // run. Transactionally, through the same handle.
          await db.transaction(async (tx) => {
            await enqueue(
              tx,
              MATERIALIZE_RECORDS_TASK,
              { domainId: domain.id },
              { jobKey: domainJobKey(MATERIALIZE_RECORDS_TASK, domain.id) },
            );
          });
        }

        /* ---- 2. THE DELEGATION GATE ------------------------------------ */
        if (providerAddedAt === null && !isDelegationConfirmed(domain)) {
          await run.step({
            step: "delegation-gate",
            status: "skipped",
            responseSummary: {
              reason: "delegation not confirmed by the DNS provider",
              providerZoneStatus: domain.providerZoneStatus,
              delegationVerified: false,
              // Stated so a reader of the run knows nothing was spent.
              providerCallsMade: 0,
            },
          });
          // A successful run. See the module doc: correctly waiting is success,
          // and `verify_attempts` is NOT incremented — no attempt was made.
          await run.finish("succeeded", null);
          return {
            runId: run.runId,
            status: "succeeded",
            outcome: "delegation_pending",
            ownershipCodeFetched,
            dns: null,
            verifyAttempts,
          };
        }

        /* ---- 3. register at the provider (ledgered) --------------------- */
        if (providerAddedAt === null) {
          const key = idempotencyKey(
            providerName,
            "mail.domain.add",
            domain.name,
          );
          const begin = await ledger.begin({
            key,
            provider: providerName,
            operation: "mail.domain.add",
            runId: run.runId,
          });

          if (begin.decision === "already_succeeded") {
            providerAddedAt = begin.row.completedAt ?? new Date();
            await run.step({
              step: "register-domain",
              status: "succeeded",
              responseSummary: {
                shortCircuited: true,
                idempotencyKey: key,
              },
            });
          } else if (begin.decision === "needs_read_back") {
            // Open question 4: a `pending` row is NEVER blindly retried. Read
            // the provider for the object the operation would have created.
            const observed = await provider.findDomainByName(domain.name);
            if (observed === null) {
              await ledger.fail(key, { readBack: "absent" });
              await run.step({
                step: "register-domain.read-back",
                status: "succeeded",
                responseSummary: { present: false, resolvedTo: "failed" },
              });
            } else {
              providerAddedAt = new Date();
              await ledger.succeed(key, { readBack: "present" });
              await run.step({
                step: "register-domain.read-back",
                status: "succeeded",
                responseSummary: { present: true, resolvedTo: "succeeded" },
              });
            }
          } else {
            try {
              await provider.addDomain(domain.name);
              providerAddedAt = new Date();
              await ledger.succeed(key, { domain: domain.name });
              await run.step({
                step: "register-domain",
                status: "succeeded",
                requestSummary: {
                  operation: "mail.domain.add",
                  domain: domain.name,
                },
                responseSummary: redact({ domain: domain.name, added: true }),
              });
            } catch (error) {
              const kind = errorKind(error);
              await ledger.fail(key, { errorKind: kind });

              if (!isOwnershipNotYetProvable(kind)) {
                // A real fault: auth, rate limit, outage. Fail loudly so the
                // job backs off and connection health reflects it.
                await run.step({
                  step: "register-domain",
                  status: "failed",
                  errorCode: kind,
                  errorDetail: "mail domain registration failed",
                });
                await run.finish("failed", `mail domain add failed (${kind})`);
                await recordProviderFailure(domain, kind);
                throw new ProviderCallError(kind, "mail domain add failed", {
                  domainId: domain.id,
                  runId: run.runId,
                });
              }

              // The EXPECTED case: the provider looked for the ownership TXT
              // and did not find it yet. Record and stop; the next run tries
              // again. This is the whole reason the workflow is a reconciler.
              const message =
                error instanceof Error ? error.message : "ownership not proved";
              await recordVerifyAttempt(message);
              await run.step({
                step: "register-domain",
                status: "failed",
                errorCode: kind,
                errorDetail:
                  "the mail provider could not yet verify the ownership record",
                responseSummary: {
                  interpretation: "ownership_pending",
                  verifyAttempts,
                },
              });
              await run.finish("partial", null);
              return {
                runId: run.runId,
                status: "partial",
                outcome: "ownership_pending",
                ownershipCodeFetched,
                dns: null,
                verifyAttempts,
              };
            }
          }

          if (providerAddedAt !== null) {
            await db
              .update(mailDomains)
              .set({ providerAddedAt, updatedAt: new Date() })
              .where(eq(mailDomains.domainId, domain.id));
          }
        }

        if (providerAddedAt === null) {
          // The read-back resolved to "absent". Safe to retry next run.
          await run.finish("partial", null);
          return {
            runId: run.runId,
            status: "partial",
            outcome: "ownership_pending",
            ownershipCodeFetched,
            dns: null,
            verifyAttempts,
          };
        }

        /* ---- 4. verify ownership + read the provider's DNS verdict ------ */
        const observed = await provider.findDomainByName(domain.name);
        if (observed === null) {
          // Registered per the ledger, absent per the provider. Not an error
          // Loxep can resolve on its own, and NOT a reason to call addDomain
          // again — that is what the ledger exists to prevent.
          await recordVerifyAttempt(
            "the mail provider does not list this domain",
          );
          await run.step({
            step: "verify-ownership",
            status: "failed",
            errorDetail: "the mail provider does not list this domain",
            responseSummary: { present: false, verifyAttempts },
          });
          await run.finish("partial", null);
          return {
            runId: run.runId,
            status: "partial",
            outcome: "ownership_pending",
            ownershipCodeFetched,
            dns: null,
            verifyAttempts,
          };
        }

        if (ownershipVerifiedAt === null) {
          ownershipVerifiedAt = new Date();
          await db
            .update(mailDomains)
            .set({
              ownershipVerifiedAt,
              lastVerifyAt: new Date(),
              lastVerifyError: null,
              updatedAt: new Date(),
            })
            .where(eq(mailDomains.domainId, domain.id));
        }

        const allPass =
          observed.dns.passesMx &&
          observed.dns.passesSpf &&
          observed.dns.passesDkim &&
          observed.dns.passesDmarc;

        await run.step({
          step: "verify-ownership",
          status: "succeeded",
          requestSummary: {
            operation: "mail.domain.list",
            domain: domain.name,
          },
          responseSummary: {
            present: true,
            isShared: observed.isShared,
            allowAccountReset: observed.allowAccountReset,
            passesMx: observed.dns.passesMx,
            passesSpf: observed.dns.passesSpf,
            passesDkim: observed.dns.passesDkim,
            passesDmarc: observed.dns.passesDmarc,
          },
        });

        await advanceState(domain, "mail_pending");
        await clearProviderFailure(domain.id);

        if (!allPass) {
          // Ask the provider to look again. Its check is asynchronous, so this
          // is a nudge whose result the NEXT run reads — which is exactly the
          // resumable shape, applied one level down.
          await provider.recheckDomainDns(domain.name);
          await run.step({
            step: "recheck-dns",
            status: "succeeded",
            requestSummary: {
              operation: "mail.domain.recheckDns",
              domain: domain.name,
            },
            responseSummary: { requested: true },
          });
          await run.finish("succeeded", null);
          return {
            runId: run.runId,
            status: "succeeded",
            outcome: "dns_pending",
            ownershipCodeFetched,
            dns: observed.dns,
            verifyAttempts,
          };
        }

        await run.finish("succeeded", null);
        return {
          runId: run.runId,
          status: "succeeded",
          outcome: "verified",
          ownershipCodeFetched,
          dns: observed.dns,
          verifyAttempts,
        };
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        const message =
          error instanceof Error ? error.message : "mail domain sync failed";
        await run.step({ step: "run", status: "failed", errorDetail: message });
        await run.finish("failed", message);
        throw error;
      }
    },

    async runMailboxSync(input) {
      const redact = input.redact ?? defaultRedactor;
      const { domain, mail } = await loadDomain(input.domainId);
      const run = await openRun(MAILBOX_RUN_KIND, input, domain.id);

      let created = 0;
      let routingRulesCreated = 0;
      let deleted = 0;
      let unchanged = 0;
      const unexpected: string[] = [];

      try {
        if (mail.ownershipVerifiedAt === null) {
          // Creating a mailbox on an unverified domain is not something the
          // provider would accept, and attempting it spends a billable call to
          // find that out.
          await run.step({
            step: "ownership-gate",
            status: "skipped",
            responseSummary: {
              reason: "the mail domain's ownership is not verified yet",
              providerCallsMade: 0,
            },
          });
          await run.finish("succeeded", null);
          return {
            runId: run.runId,
            status: "succeeded",
            created: 0,
            routingRulesCreated: 0,
            deleted: 0,
            unchanged: 0,
            unexpected: [],
          };
        }

        const live = await db
          .select()
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.domainId, domain.id),
              isNull(mailboxes.desiredDeletedAt),
            ),
          );
        const tombstoned = await db
          .select()
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.domainId, domain.id),
              isNotNull(mailboxes.desiredDeletedAt),
              isNotNull(mailboxes.providerCreatedAt),
            ),
          );

        await run.step({
          step: "read-intent",
          status: "succeeded",
          responseSummary: {
            live: live.length,
            pendingRemovals: tombstoned.length,
          },
        });

        const observedUsers = await provider.listUsers();
        const observedRules = await provider.listRoutingRules();
        const suffix = `@${domain.name}`;
        const usersHere = new Set(
          observedUsers
            .filter((address) => address.endsWith(suffix))
            .map((address) => address.slice(0, -suffix.length)),
        );
        const rulesHere = new Map(
          observedRules
            .filter((rule) => rule.domainName === domain.name)
            .map((rule) => [rule.matchUser, rule]),
        );

        await run.step({
          step: "read-provider",
          status: "succeeded",
          requestSummary: { operation: "mail.user.list", domain: domain.name },
          responseSummary: {
            users: usersHere.size,
            routingRules: rulesHere.size,
          },
        });

        /* ---- create what intent describes and the provider lacks -------- */
        for (const row of live) {
          if (row.kind === "mailbox") {
            if (usersHere.has(row.localPart)) {
              unchanged += 1;
              if (row.providerCreatedAt === null) {
                await db
                  .update(mailboxes)
                  .set({ providerCreatedAt: new Date(), updatedAt: new Date() })
                  .where(eq(mailboxes.id, row.id));
              }
              continue;
            }

            const key = idempotencyKey(
              providerName,
              "mail.user.create",
              `${row.localPart}${suffix}`,
            );
            const begin = await ledger.begin({
              key,
              provider: providerName,
              operation: "mail.user.create",
              runId: run.runId,
            });

            if (begin.decision === "already_succeeded") {
              await db
                .update(mailboxes)
                .set({ providerCreatedAt: new Date(), updatedAt: new Date() })
                .where(eq(mailboxes.id, row.id));
              await run.step({
                step: "create-mailbox",
                status: "succeeded",
                responseSummary: { shortCircuited: true, localPart: row.localPart },
              });
              continue;
            }
            if (begin.decision === "needs_read_back") {
              // A mailbox create is BILLABLE. This is the case open question
              // 4's read-back rule was written for: the list above already
              // told us whether it exists, so resolve from that rather than
              // spending another create.
              await ledger.fail(key, { readBack: "absent" });
              await run.step({
                step: "create-mailbox.read-back",
                status: "succeeded",
                responseSummary: {
                  localPart: row.localPart,
                  present: false,
                  resolvedTo: "failed",
                },
              });
              continue;
            }

            // Mint, store, THEN call. The order matters: a crash after the
            // provider call but before the secret write would leave a mailbox
            // whose password is lost, which is unrecoverable without a reset.
            const password = mintPassword();
            const secret = await secrets.setSecret({
              secretKey: `infrastructure.mailbox.${row.id}`,
              purpose: "mailbox_password",
              payload: { password },
              actorUserId: input.actorUserId ?? null,
            });
            await db
              .update(mailboxes)
              .set({ secretId: secret.id, updatedAt: new Date() })
              .where(eq(mailboxes.id, row.id));

            try {
              await provider.createUser({
                userName: row.localPart,
                domainName: domain.name,
                password,
              });
            } catch (error) {
              const kind = errorKind(error);
              await ledger.fail(key, { errorKind: kind });
              // NOTE the deliberate asymmetry with `addDomain`, which treats
              // `invalid_request` as "not proved yet" rather than as a fault.
              // `isOwnershipNotYetProvable` is domain-only ON PURPOSE: there
              // is nothing for a mailbox create to be waiting on. Ownership is
              // already verified by the time this runs, so a refusal here means
              // the request itself is wrong — a local part the provider will
              // not accept, an exhausted account — and retrying it on a timer
              // would fail identically forever while looking like patience.
              await run.step({
                step: "create-mailbox",
                status: "failed",
                errorCode: kind,
                errorDetail: "mailbox creation failed",
                // The local part, never the password. `password` is not in
                // scope for any summary builder in this module.
                requestSummary: {
                  operation: "mail.user.create",
                  localPart: row.localPart,
                  passwordOmitted: true,
                },
              });
              await run.finish("partial", `mailbox create failed (${kind})`);
              await recordProviderFailure(domain, kind);
              throw new ProviderCallError(kind, "mailbox create failed", {
                domainId: domain.id,
                runId: run.runId,
              });
            }

            await ledger.succeed(key, { localPart: row.localPart });
            await db
              .update(mailboxes)
              .set({ providerCreatedAt: new Date(), updatedAt: new Date() })
              .where(eq(mailboxes.id, row.id));
            created += 1;
            await run.step({
              step: "create-mailbox",
              status: "succeeded",
              requestSummary: {
                operation: "mail.user.create",
                localPart: row.localPart,
                passwordOmitted: true,
              },
              responseSummary: redact({
                localPart: row.localPart,
                created: true,
                passwordOmitted: true,
              }),
            });
            continue;
          }

          // An alias or catch-all: a routing rule, not an account, and not
          // billable.
          if (row.forwardTo === null) {
            throw new InfrastructureValidationError(
              `mailbox ${row.id} is a "${row.kind}" with no forwarding address`,
              { mailboxId: row.id },
            );
          }

          const existingRule = rulesHere.get(row.localPart);
          if (existingRule !== undefined) {
            // **Compare the rule's CONTENT, not just its existence.** Matching
            // on the local part alone would mean that changing an alias's
            // forwarding address in intent leaves the provider forwarding to
            // the old one forever — silently, and reported as `unchanged`,
            // which is the shape of bug this whole domain exists to prevent.
            // (Found by a test, not by review.)
            const converged =
              existingRule.targetAddresses.length === 1 &&
              existingRule.targetAddresses[0] === row.forwardTo &&
              existingRule.catchall === (row.kind === "catchall") &&
              existingRule.prefix === false;
            if (converged) {
              unchanged += 1;
              if (row.providerCreatedAt === null) {
                await db
                  .update(mailboxes)
                  .set({ providerCreatedAt: new Date(), updatedAt: new Date() })
                  .where(eq(mailboxes.id, row.id));
              }
              continue;
            }
            // The provider offers create and delete for routing rules and no
            // update, so convergence is delete-then-create. Safe to do
            // unattended in a way a MAILBOX delete never is: a routing rule
            // holds no mail, and the rule being replaced is one Loxep's own
            // intent describes.
            await provider.deleteRoutingRule(existingRule.id);
            await run.step({
              step: "replace-routing-rule",
              status: "succeeded",
              requestSummary: {
                operation: "mail.routing.delete",
                localPart: row.localPart,
                reason: "forwarding target or catch-all flag changed",
              },
            });
          }

          await provider.createRoutingRule({
            domainName: domain.name,
            matchUser: row.localPart,
            targetAddresses: [row.forwardTo],
            catchall: row.kind === "catchall",
          });
          await db
            .update(mailboxes)
            .set({ providerCreatedAt: new Date(), updatedAt: new Date() })
            .where(eq(mailboxes.id, row.id));
          routingRulesCreated += 1;
          await run.step({
            step: "create-routing-rule",
            status: "succeeded",
            requestSummary: {
              operation: "mail.routing.create",
              localPart: row.localPart,
              catchall: row.kind === "catchall",
            },
            responseSummary: redact({ localPart: row.localPart, created: true }),
          });
        }

        /* ---- remove what an operator explicitly soft-deleted ------------ */
        for (const row of tombstoned) {
          if (row.kind === "mailbox") {
            if (!usersHere.has(row.localPart)) {
              // Already gone. Clear the marker so the next run does not look
              // again — convergence, not failure.
              await db
                .update(mailboxes)
                .set({ providerCreatedAt: null, updatedAt: new Date() })
                .where(eq(mailboxes.id, row.id));
              continue;
            }
            await provider.deleteUser(`${row.localPart}${suffix}`);
          } else {
            const rule = rulesHere.get(row.localPart);
            if (rule === undefined) {
              await db
                .update(mailboxes)
                .set({ providerCreatedAt: null, updatedAt: new Date() })
                .where(eq(mailboxes.id, row.id));
              continue;
            }
            await provider.deleteRoutingRule(rule.id);
          }
          await db
            .update(mailboxes)
            .set({ providerCreatedAt: null, updatedAt: new Date() })
            .where(eq(mailboxes.id, row.id));
          deleted += 1;
          await run.step({
            step: "delete-mailbox",
            status: "succeeded",
            requestSummary: {
              operation:
                row.kind === "mailbox"
                  ? "mail.user.delete"
                  : "mail.routing.delete",
              localPart: row.localPart,
            },
          });
        }

        /* ---- report, never delete, what intent does not describe -------- */
        const intended = new Set(live.map((row) => row.localPart));
        const wasIntended = (localPart: string): boolean =>
          intended.has(localPart) ||
          tombstoned.some((row) => row.localPart === localPart);

        for (const localPart of usersHere) {
          if (wasIntended(localPart)) continue;
          unexpected.push(`${localPart}${suffix}`);
        }
        // Routing rules are scanned too, not just accounts. An alias somebody
        // hand-created in the provider's dashboard is exactly as much of a
        // surprise as an unmanaged mailbox — and a catch-all in particular can
        // silently swallow every address the operator thinks is unrouted. The
        // asymmetry of reporting one and not the other was a real gap, caught
        // by review of the first implementation.
        for (const localPart of rulesHere.keys()) {
          if (wasIntended(localPart)) continue;
          unexpected.push(`${localPart}${suffix}`);
        }
        if (unexpected.length > 0) {
          await run.step({
            step: "unexpected-mailboxes",
            status: "succeeded",
            responseSummary: {
              // Addresses only. Never deleted, in any mode — the milestone-1
              // rule for unexpected DNS records, applied where the stakes are
              // higher because a mailbox holds mail and a deletion takes it.
              count: unexpected.length,
              addresses: [...new Set(unexpected)],
              action: "reported-only",
            },
          });
        }

        await clearProviderFailure(domain.id);

        // `ready` is claimed only when there is genuinely nothing left to do.
        const outstanding = await db
          .select()
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.domainId, domain.id),
              isNull(mailboxes.desiredDeletedAt),
              isNull(mailboxes.providerCreatedAt),
            ),
          );
        if (outstanding.length === 0 && live.length > 0) {
          await advanceState(domain, "ready");
        }

        await run.finish("succeeded", null);
        return {
          runId: run.runId,
          status: "succeeded",
          created,
          routingRulesCreated,
          deleted,
          unchanged,
          unexpected,
        };
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        const message =
          error instanceof Error ? error.message : "mailbox sync failed";
        await run.step({ step: "run", status: "failed", errorDetail: message });
        await run.finish("failed", message);
        throw error;
      }
    },
  };
}
