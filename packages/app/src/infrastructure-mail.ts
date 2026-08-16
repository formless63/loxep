/**
 * The Infrastructure mail tasks — composition-root wiring for Phase 7
 * milestone 2 (loxep-lmy.2).
 *
 * ```text
 * infrastructure.ensure-mail-domain   intent change (mail enabled)
 * infrastructure.poll-mail-ownership  bounded poll, GATED ON DELEGATION
 * infrastructure.sync-mailboxes       after ownership verification
 *      |
 *      +→ resolve the domain's MAIL connection from mail_domains
 *      +→ build the Purelymail adapter (purelymail.ts: token + budget)
 *      +→ wrap it as @loxep/infrastructure's MailProviderPort
 *      +→ createMailSyncService(...).runMailDomainSync / runMailboxSync
 * ```
 *
 * ## No new monitor target type, and that is the design's own answer
 *
 * The obvious move — registering `infrastructure_mail_verify` against the
 * shared scheduling model the way milestone 1 registered
 * `infrastructure_domain_reconcile` — is **wrong here**, and the design says so
 * before the question is asked. Its "Where recurring cadence lives" section
 * splits the work into three kinds and rules on exactly this one:
 *
 * ```text
 * event-driven   intent changed -> reconcile now       NOT scheduling
 * bounded poll   delegation, OWNERSHIP VERIFICATION     NOT scheduling
 * recurring      periodic drift sweep per domain        THIS is scheduling
 * ```
 *
 * Ownership verification is named in the middle row. It is **self-terminating**
 * — it ends when the domain verifies, which happens once and never again — and
 * the design's delegation-polling paragraph prescribes its shape directly:
 * *"a bounded, self-terminating schedule — frequent attempts for the first
 * hour, sparse attempts for the following days, then stop and surface
 * 'delegation never completed' with a manual retry in the UI."* A
 * `monitor_targets` row is the wrong container for that: it is a permanent
 * cadence with claim semantics and an adaptive policy, and it would leave a
 * dead row per domain forever after the one event it was watching for.
 *
 * So milestone 2 adds **no** target type, and the "register the target type and
 * its config schema together" lesson does not apply — there is nothing to
 * register. `@loxep/market` is untouched, and the third-registrant question the
 * design raises (whether to build a runtime registration seam) is not made
 * fourth by this milestone. Recorded here because a reader who knows milestone
 * 1's wiring will look for the fourth route and needs to find the reason it is
 * absent rather than conclude it was forgotten.
 *
 * ## The two flavors of "not done yet", and why only one is an error
 *
 * `runMailDomainSync` returns an outcome rather than throwing for the states
 * that are supposed to happen: `delegation_pending` (correctly waiting for the
 * registrar; **no provider call was made**) and `ownership_pending` (the
 * provider looked and was not yet satisfied). These tasks log them and return
 * normally — retrying immediately would spend the operator's provider budget on
 * a question DNS cannot answer for hours yet, and failing the job would light
 * up every health indicator in the product for an entirely normal condition.
 *
 * A real fault — `auth`, `rate_limited`, `provider_unavailable` — arrives as a
 * thrown `ProviderCallError`, fails the job, records connection health, and
 * gets Graphile Worker's exponential backoff. That is the distinction the mail
 * reconciler exists to draw, and this module is where it becomes job behavior.
 */
import { defineTask } from "@loxep/jobs";
import type { LoxepTask } from "@loxep/jobs";
import {
  ENSURE_MAIL_DOMAIN_TASK,
  POLL_MAIL_OWNERSHIP_TASK,
  ProviderCallError,
  SYNC_MAILBOXES_TASK,
  createMailSyncService,
  createTransactionalEnqueue,
} from "@loxep/infrastructure";
import type {
  MailProviderPort,
  MailSyncService,
  RunMailSyncInput,
} from "@loxep/infrastructure";
import type { ResponseRedactor } from "@loxep/infrastructure";
import type { PurelymailAdapter } from "@loxep/integration-purelymail";
import { z } from "zod";
import { AppConfigurationError } from "./errors.ts";
import { PURELYMAIL_CONNECTION_PROVIDER } from "./purelymail.ts";
import type { AppServices } from "./services.ts";

/**
 * Adapt a {@link PurelymailAdapter} to `@loxep/infrastructure`'s
 * `MailProviderPort`.
 *
 * The two shapes are structurally compatible by design (`mail-port.ts`'s module
 * doc: "re-declared structurally rather than imported"), so this is a thin
 * forward rather than a translation — but it is written as explicit method
 * calls, never destructured, so an adapter method that calls a sibling through
 * `this` keeps its binding. `providerPortFromCloudflareAdapter` learned that
 * the same way.
 */
export function mailProviderPortFromPurelymailAdapter(
  adapter: PurelymailAdapter,
): MailProviderPort {
  return {
    getOwnershipCode: () => adapter.getOwnershipCode(),
    addDomain: (name) => adapter.addDomain(name),
    findDomainByName: (name) => adapter.findDomainByName(name),
    recheckDomainDns: (name) => adapter.recheckDomainDns(name),
    createUser: (input) => adapter.createUser(input),
    deleteUser: (fullAddress) => adapter.deleteUser(fullAddress),
    listUsers: () => adapter.listUsers(),
    listRoutingRules: () => adapter.listRoutingRules(),
    createRoutingRule: (input) => adapter.createRoutingRule(input),
    deleteRoutingRule: (id) => adapter.deleteRoutingRule(id),
    requiredRecords: (input) => adapter.requiredRecords(input),
    capabilities: () => adapter.capabilities(),
  };
}

/**
 * The `reconcile_run_steps` redactor for this adapter.
 *
 * An explicit ALLOW-LIST over the small Loxep-owned facts `mail-sync.ts`
 * actually passes to a redactor — never a provider payload, and structurally
 * incapable of carrying a minted mailbox password: `password` is not a key this
 * function reads, and the only summary builder that touches a mailbox create
 * receives `{localPart, created, passwordOmitted}` with the password out of
 * scope entirely.
 */
export const purelymailResultRedactor: ResponseRedactor = (value) => {
  const record = (value ?? {}) as Record<string, unknown>;
  const pick = (key: string): string | boolean | null => {
    const entry = record[key];
    if (typeof entry === "string" || typeof entry === "boolean") return entry;
    return null;
  };
  return {
    domain: pick("domain"),
    localPart: pick("localPart"),
    added: pick("added"),
    created: pick("created"),
    passwordOmitted: true,
  };
};

/**
 * Build the mail sync service for one managed domain, resolving the mail
 * connection from `mail_domains` rather than from a job payload — Configuration
 * & Secrets rule 5, and the reason every payload here carries a `domainId` and
 * nothing else.
 */
export async function createMailSyncForDomain(
  services: AppServices,
  domainId: string,
): Promise<MailSyncService> {
  const mail = await services.db.query.mailDomains.findFirst({
    where: (table, { eq }) => eq(table.domainId, domainId),
  });
  if (mail === undefined) {
    throw new AppConfigurationError(
      `managed domain ${domainId} has no mail registration; enable mail before reconciling it`,
    );
  }

  const purelymail = await services.getPurelymailAdapterForConnection(
    mail.mailConnectionId,
  );

  return createMailSyncService({
    db: services.db,
    provider: mailProviderPortFromPurelymailAdapter(purelymail.adapter),
    // The WRITE-ONLY secret seam. `SecretsService` satisfies it structurally;
    // `MailboxSecretWriter` exposes no read member, so nothing downstream of
    // here can retrieve a stored mailbox password.
    secrets: services.secrets,
    providerName: PURELYMAIL_CONNECTION_PROVIDER,
    enqueue: createTransactionalEnqueue(),
    // Write-authorization gate (Pangolin chain design M3, loxep-acj.3): the
    // owner's Purelymail token has no scoping at all, so this connection's
    // stored policy defaults to read_only and every write is refused
    // (recorded as a 'blocked' step) until an admin flips it.
    connectionId: mail.mailConnectionId,
  });
}

const mailPayloadSchema = z.object({
  domainId: z.string().uuid(),
  correlationId: z.string().min(1).optional(),
});

export interface InfrastructureMailTasks {
  ensureMailDomainTask: LoxepTask<typeof mailPayloadSchema>;
  pollMailOwnershipTask: LoxepTask<typeof mailPayloadSchema>;
  syncMailboxesTask: LoxepTask<typeof mailPayloadSchema>;
  tasks: readonly LoxepTask<typeof mailPayloadSchema>[];
}

export function createInfrastructureMailTasks(options: {
  services: AppServices;
}): InfrastructureMailTasks {
  const { services } = options;

  /** Both domain-level tasks run the SAME function — see `tasks.ts`. */
  const runDomainSync = async (
    domainId: string,
    trigger: RunMailSyncInput["trigger"],
    logger: { info: (fields: Record<string, unknown>, msg?: string) => void },
  ): Promise<void> => {
    const sync = await createMailSyncForDomain(services, domainId);
    const mail = await services.db.query.mailDomains.findFirst({
      where: (table, { eq }) => eq(table.domainId, domainId),
    });
    const connectionId = mail?.mailConnectionId ?? null;

    try {
      const result = await sync.runMailDomainSync({
        domainId,
        trigger,
        redact: purelymailResultRedactor,
      });
      if (connectionId !== null) {
        await services.connections.recordConnectionSuccess(connectionId);
      }
      logger.info(
        {
          domainId,
          runId: result.runId,
          status: result.status,
          outcome: result.outcome,
          verifyAttempts: result.verifyAttempts,
          ownershipCodeFetched: result.ownershipCodeFetched,
        },
        // Phrased as progress rather than as an error: `delegation_pending`
        // and `ownership_pending` are the normal outcomes for days.
        "infrastructure mail domain sync complete",
      );
    } catch (error) {
      if (error instanceof ProviderCallError && connectionId !== null) {
        if (error.kind === "auth") {
          services.invalidatePurelymailAdapter(connectionId);
        }
        await services.connections
          .recordConnectionFailure(connectionId, {
            errorCode: `purelymail_${error.kind}`,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  };

  const ensureMailDomainTask = defineTask({
    name: ENSURE_MAIL_DOMAIN_TASK,
    payloadSchema: mailPayloadSchema,
    handler: async (payload, { logger }) => {
      await runDomainSync(payload.domainId, "intent_change", logger);
    },
  });

  const pollMailOwnershipTask = defineTask({
    name: POLL_MAIL_OWNERSHIP_TASK,
    payloadSchema: mailPayloadSchema,
    handler: async (payload, { logger }) => {
      await runDomainSync(payload.domainId, "poll", logger);
    },
  });

  const syncMailboxesTask = defineTask({
    name: SYNC_MAILBOXES_TASK,
    payloadSchema: mailPayloadSchema,
    handler: async (payload, { logger }) => {
      const sync = await createMailSyncForDomain(services, payload.domainId);
      const mail = await services.db.query.mailDomains.findFirst({
        where: (table, { eq }) => eq(table.domainId, payload.domainId),
      });
      const connectionId = mail?.mailConnectionId ?? null;
      try {
        const result = await sync.runMailboxSync({
          domainId: payload.domainId,
          trigger: "intent_change",
          redact: purelymailResultRedactor,
        });
        if (connectionId !== null) {
          await services.connections.recordConnectionSuccess(connectionId);
        }
        logger.info(
          {
            domainId: payload.domainId,
            runId: result.runId,
            created: result.created,
            routingRulesCreated: result.routingRulesCreated,
            deleted: result.deleted,
            unchanged: result.unchanged,
            // Count only. The addresses are in the run step; a log line is the
            // wrong place to accumulate an installation's address book.
            unexpected: result.unexpected.length,
          },
          "infrastructure mailbox sync complete",
        );
      } catch (error) {
        if (error instanceof ProviderCallError && connectionId !== null) {
          if (error.kind === "auth") {
            services.invalidatePurelymailAdapter(connectionId);
          }
          await services.connections
            .recordConnectionFailure(connectionId, {
              errorCode: `purelymail_${error.kind}`,
            })
            .catch(() => undefined);
        }
        throw error;
      }
    },
  });

  return {
    ensureMailDomainTask,
    pollMailOwnershipTask,
    syncMailboxesTask,
    tasks: [ensureMailDomainTask, pollMailOwnershipTask, syncMailboxesTask],
  };
}
