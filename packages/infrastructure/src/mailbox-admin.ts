/**
 * Per-row Purelymail mailbox and routing-rule admin verbs (loxep-47o.11).
 *
 * `mail-sync.ts` converges a domain's WHOLE mailbox set against declared
 * intent, and it deletes exactly one thing: an address an operator soft-
 * deleted, discovered on the next scheduled or triggered convergence. There
 * was no service-layer way to reach for ONE address and delete it NOW, or to
 * delete a single routing rule outside that same batch loop — the estate
 * page (`/infrastructure/estate/$connectionId`) can only show what an
 * operator would want to act on one row at a time. This module is that
 * missing layer, built to `mail-sync.ts`'s own discipline: idempotent,
 * ledgered into `reconcile_runs`/`reconcile_run_steps`, and
 * `assertWritePolicy`-gated before the first write.
 *
 * ## Deliberately absent: `modifyMailbox`
 *
 * The bead that files this module assumed `PurelymailAdapter` already
 * exposes a `modifyUser` method (alongside `createUser`/`deleteUser`/
 * `createRoutingRule`/`deleteRoutingRule`). It does not.
 * `packages/integrations/purelymail/src/adapter.ts`'s `PurelymailAdapter`
 * interface has no `modifyUser` member at all — `"user.modify": "modifyUser"`
 * exists ONLY in `operations.ts`'s raw name map, in the exact same
 * deliberately-unwired category as `appPassword.create`/the password-reset
 * operations, per that file's own doc ("UNVERIFIED, and deliberately NOT
 * wired to an adapter method"). Building a mailbox-modify verb against a real
 * call would require adding that method to the adapter, and
 * `packages/integrations/purelymail` is READ-ONLY under this bead's own
 * fence. Rather than fabricate a call against a method that does not exist,
 * or add a fake pass-through that silently does nothing, this module ships
 * `deleteMailboxNow` and the routing-rule verbs only — `modifyMailbox` is
 * NOT built, and the gap is recorded here for the owner to resolve (widen the
 * fence to add `modifyUser` to the real adapter, or drop the verb from
 * scope).
 *
 * ## `deleteDomain` — still permanently unreachable
 *
 * Not referenced anywhere in this module, matching `mail-sync.ts` and the
 * design doc's "Permanently read-only here" list — see
 * `mailbox-admin.test.ts`'s boundary test.
 *
 * ## Two destructive verbs, ONE non-default tier, always explicit
 *
 * `deleteMailboxNow` and `deleteRoutingRule` both assert
 * `operationTier: 2` (`access_affecting`) EXPLICITLY — never
 * `assertWritePolicy`'s bare default, and never the tier-1 gate
 * `mail-sync.ts`'s own `runMailboxSync` uses for its batch create/delete
 * loop. A connection whose policy permits only `'additive'` writes (enough
 * for `runMailboxSync`'s tombstone-driven convergence) still refuses a
 * direct single-mailbox delete from this module — by design, per the bead's
 * own ruling: "never additive, regardless of what tier the connection is
 * currently set to for its additive writes." `createRoutingRule` is the one
 * additive (tier 1) verb here, matching `runMailboxSync`'s own tier for a
 * routing-rule create.
 *
 * ## Typed confirmation is INPUT VALIDATION, checked inside the service
 *
 * Both destructive verbs take a `confirmationText` and refuse (throwing
 * {@link InfrastructureValidationError}) when it does not match the object's
 * own identity — the FULL mailbox address for `deleteMailboxNow`, and
 * `"<matchUser>@<domainName>"` read FRESH from the provider for
 * `deleteRoutingRule` (never the caller's own copy, mirroring
 * `retireProxyResourceRule`'s "re-verified server-side against the resource's
 * OWN full domain" precedent — `apps/web/src/server/infrastructure-
 * functions.ts`). The comparison lives here, in the service, rather than
 * only at the `apps/web` server-function layer, specifically so it is
 * package-testable without a running app.
 *
 * ## Idempotency: double-delete is a no-op, not an error
 *
 * `deleteMailboxNow` short-circuits with no provider call at all when the
 * matching `mailboxes` row is already tombstoned with no provider evidence
 * left (`desiredDeletedAt` set, `providerCreatedAt` null); otherwise it
 * treats a `not_found` classification from `provider.deleteUser` as
 * "already gone", not a fault. `deleteRoutingRule` reads the provider's rule
 * list fresh and treats an absent id the same way. Both keep the Loxep
 * `mailboxes` intent row in step with what was just done (soft-deleting or
 * clearing `providerCreatedAt`) so the NEXT `runMailboxSync` does not read
 * stale intent and try to recreate what an operator just removed.
 */
import type { LoxepDb } from "@loxep/db";
import { mailboxes, managedDomains, reconcileRunSteps, reconcileRuns } from "@loxep/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import {
  createSettingsService,
  providerWritePolicySetting,
  resolveProviderWritePolicy,
} from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
} from "./errors.ts";
import { createMailDomainsService } from "./mail.ts";
import type { MailProviderPort } from "./mail-port.ts";
import { assertWritePolicy, WritePolicyError } from "./write-policy.ts";
import type { WriteOperationTier } from "./write-policy.ts";

/** `reconcile_runs.kind` values this module writes. */
export const DELETE_MAILBOX_NOW_RUN_KIND = "delete-mailbox-now";
export const CREATE_ROUTING_RULE_RUN_KIND = "create-routing-rule";
export const DELETE_ROUTING_RULE_RUN_KIND = "delete-routing-rule";

type Trigger = "intent_change" | "sweep" | "manual" | "poll";

interface ActorInput {
  trigger: Trigger;
  actorUserId?: string | null;
  /** See `write-policy.ts`'s `assertWritePolicy` doc: `undefined` is "no known actor", `false` always refuses. */
  actorIsAdmin?: boolean;
}

export interface DeleteMailboxNowInput extends ActorInput {
  /** `managed_domains.id` — the reconcile run's subject, and how the domain's own name is resolved. */
  domainId: string;
  /** The FULL address, e.g. `postmaster@example.com`. */
  address: string;
  /** Must equal `address` exactly. Checked BEFORE any run is opened. */
  confirmationText: string;
}

export interface DeleteMailboxNowResult {
  runId: string;
  status: "succeeded" | "failed" | "partial";
  outcome: "deleted" | "already_absent" | "write_policy_blocked";
}

export interface CreateRoutingRuleInput extends ActorInput {
  domainId: string;
  matchUser: string;
  targetAddresses: string[];
  prefix?: boolean;
  catchall?: boolean;
}

export interface CreateRoutingRuleResult {
  runId: string;
  status: "succeeded" | "failed" | "partial";
  outcome: "created" | "already_exists" | "write_policy_blocked";
}

export interface DeleteRoutingRuleInput extends ActorInput {
  domainId: string;
  /** Purelymail's own int64 rule id. */
  routingRuleId: number;
  /** Must equal `"<matchUser>@<domainName>"`, read fresh from the provider. */
  confirmationText: string;
}

export interface DeleteRoutingRuleResult {
  runId: string;
  status: "succeeded" | "failed" | "partial";
  outcome: "deleted" | "already_absent" | "write_policy_blocked";
}

export interface MailboxAdminService {
  /** Destructive. Tier `access_affecting` (2), typed confirmation of the full address. */
  deleteMailboxNow(input: DeleteMailboxNowInput): Promise<DeleteMailboxNowResult>;
  /** Additive. Tier `additive` (1). */
  createRoutingRule(input: CreateRoutingRuleInput): Promise<CreateRoutingRuleResult>;
  /** Destructive. Tier `access_affecting` (2), typed confirmation of the rule's match pattern. */
  deleteRoutingRule(input: DeleteRoutingRuleInput): Promise<DeleteRoutingRuleResult>;
}

export interface CreateMailboxAdminServiceOptions {
  db: LoxepDb;
  provider: MailProviderPort;
  /** `provider_operations`/log namespace, e.g. `purelymail`. Defaults to `mail`. */
  providerName?: string;
  /** Same optional/backward-compatible gate `mail-sync.ts` documents — every real caller must supply it. */
  connectionId?: string;
  /** Defaults to `createSettingsService({ db })`. Overridable for tests. */
  settings?: SettingsService;
}

function errorKind(error: unknown): string {
  return error instanceof Error && "kind" in error
    ? String((error as { kind: unknown }).kind)
    : "provider_unavailable";
}

export function createMailboxAdminService(
  options: CreateMailboxAdminServiceOptions,
): MailboxAdminService {
  const { db, provider } = options;
  const providerName = options.providerName ?? "mail";
  const settings = options.settings ?? createSettingsService({ db });
  const connectionId = options.connectionId;
  const mailDomains = createMailDomainsService({ db });

  /**
   * The write-authorization gate, with the operation's tier passed EXPLICITLY
   * by every caller below — never a default. Mirrors `mail-sync.ts`'s own
   * `checkWritePolicy` shape and `blockedReason` choice (`'credential_scope'`:
   * the Purelymail credential itself has no scoping, independent of which
   * write this is — see that module's doc).
   */
  async function checkWritePolicy(
    trigger: Trigger,
    actorIsAdmin: boolean | undefined,
    operationTier: WriteOperationTier,
    unblockHint: string,
  ): Promise<{ errorCode: string; errorDetail: string } | null> {
    if (connectionId === undefined) return null;
    const policies = await settings.get(providerWritePolicySetting);
    const policyTier = resolveProviderWritePolicy(policies, connectionId);
    try {
      assertWritePolicy({
        mode: "apply",
        trigger,
        policyTier,
        operationTier,
        actorIsAdmin,
        blockedReason: "credential_scope",
        unblockHint,
      });
      return null;
    } catch (error) {
      if (!(error instanceof WritePolicyError)) throw error;
      return { errorCode: error.blockedReason, errorDetail: error.message };
    }
  }

  async function loadDomain(domainId: string): Promise<{ id: string; name: string }> {
    const rows = await db
      .select({ id: managedDomains.id, name: managedDomains.name })
      .from(managedDomains)
      .where(eq(managedDomains.id, domainId));
    const domain = rows[0];
    if (domain === undefined) {
      throw new InfrastructureNotFoundError(`managed domain ${domainId} not found`, {
        domainId,
      });
    }
    return domain;
  }

  /** One run row plus its step recorder — the same shape `mail-sync.ts`'s `openRun` writes. */
  async function openRun(
    kind: string,
    input: ActorInput,
    subjectId: string,
  ): Promise<{
    runId: string;
    step: (entry: {
      step: string;
      status: "succeeded" | "failed" | "skipped" | "blocked";
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
          .set({ status, finishedAt: new Date(), stepCount: sequence, errorSummary })
          .where(eq(reconcileRuns.id, run.id));
      },
    };
  }

  return {
    async deleteMailboxNow(input) {
      // Input validation FIRST, no run opened for a mismatch — the confirmed
      // identity is already fully known from the input, no I/O required.
      if (input.confirmationText !== input.address) {
        throw new InfrastructureValidationError(
          `confirmation text did not match the mailbox address (expected "${input.address}")`,
          { expected: input.address },
        );
      }

      const domain = await loadDomain(input.domainId);
      const suffix = `@${domain.name}`;
      if (!input.address.endsWith(suffix)) {
        throw new InfrastructureValidationError(
          `address "${input.address}" does not belong to domain "${domain.name}"`,
          { domainId: domain.id, address: input.address },
        );
      }
      const localPart = input.address.slice(0, -suffix.length);

      const existingRows = await db
        .select()
        .from(mailboxes)
        .where(and(eq(mailboxes.domainId, domain.id), eq(mailboxes.localPart, localPart)));
      const existing = existingRows[0];
      if (existing !== undefined && existing.kind !== "mailbox") {
        throw new InfrastructureValidationError(
          `"${input.address}" is a Loxep "${existing.kind}" (a routing rule), not a mailbox — use deleteRoutingRule`,
          { mailboxId: existing.id, kind: existing.kind },
        );
      }

      const run = await openRun(DELETE_MAILBOX_NOW_RUN_KIND, input, domain.id);

      try {
        // Cheapest idempotency check first: already tombstoned with no
        // provider evidence left means a prior call already finished this.
        if (
          existing !== undefined &&
          existing.desiredDeletedAt !== null &&
          existing.providerCreatedAt === null
        ) {
          await run.step({
            step: "already-processed",
            status: "succeeded",
            responseSummary: { address: input.address, alreadyProcessed: true },
          });
          await run.finish("succeeded", null);
          return { runId: run.runId, status: "succeeded", outcome: "already_absent" };
        }

        await run.step({
          step: "read-intent",
          status: "succeeded",
          responseSummary: { address: input.address, hasLoxepRow: existing !== undefined },
        });

        const blocked = await checkWritePolicy(
          input.trigger,
          input.actorIsAdmin,
          2,
          "allow access-affecting writes for this Purelymail connection " +
            "(currently below that tier by policy) on /settings/connections to delete this mailbox",
        );
        if (blocked !== null) {
          await run.step({
            step: "delete-mailbox",
            status: "blocked",
            errorCode: blocked.errorCode,
            errorDetail: blocked.errorDetail,
          });
          await run.finish("partial", null);
          return { runId: run.runId, status: "partial", outcome: "write_policy_blocked" };
        }

        // The intent side FIRST, so a crash between here and the provider
        // call still leaves the next runMailboxSync converged rather than
        // fighting to recreate what an operator just asked to delete.
        if (existing !== undefined) {
          await mailDomains.removeMailbox(existing.id, {
            actorUserId: input.actorUserId ?? null,
          });
        }

        let alreadyAbsent = false;
        try {
          await provider.deleteUser(input.address);
        } catch (error) {
          const kind = errorKind(error);
          if (kind !== "not_found") {
            await run.step({
              step: "delete-mailbox",
              status: "failed",
              errorCode: kind,
              errorDetail: "mailbox delete failed",
              requestSummary: { operation: "mail.user.delete", address: input.address },
            });
            await run.finish("failed", `mailbox delete failed (${kind})`);
            throw new ProviderCallError(kind, "mailbox delete failed", {
              domainId: domain.id,
              runId: run.runId,
            });
          }
          alreadyAbsent = true;
        }

        if (existing !== undefined) {
          await db
            .update(mailboxes)
            .set({ providerCreatedAt: null, updatedAt: new Date() })
            .where(eq(mailboxes.id, existing.id));
        }

        await run.step({
          step: "delete-mailbox",
          status: "succeeded",
          requestSummary: { operation: "mail.user.delete", address: input.address },
          responseSummary: { alreadyAbsent },
        });
        await run.finish("succeeded", null);
        return {
          runId: run.runId,
          status: "succeeded",
          outcome: alreadyAbsent ? "already_absent" : "deleted",
        };
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        const message = error instanceof Error ? error.message : "mailbox delete failed";
        await run.step({ step: "run", status: "failed", errorDetail: message });
        await run.finish("failed", message);
        throw error;
      }
    },

    async createRoutingRule(input) {
      const domain = await loadDomain(input.domainId);
      const run = await openRun(CREATE_ROUTING_RULE_RUN_KIND, input, domain.id);

      try {
        const rules = await provider.listRoutingRules();
        const catchall = input.catchall ?? false;
        const existing = rules.find(
          (rule) =>
            rule.domainName === domain.name &&
            rule.matchUser === input.matchUser &&
            rule.catchall === catchall,
        );

        await run.step({
          step: "read-provider",
          status: "succeeded",
          requestSummary: { operation: "mail.routing.list", domain: domain.name },
          responseSummary: { rules: rules.length },
        });

        const blocked = await checkWritePolicy(
          input.trigger,
          input.actorIsAdmin,
          1,
          "allow writes for this Purelymail connection " +
            "(currently read-only by policy) on /settings/connections to create this routing rule",
        );
        if (blocked !== null) {
          await run.step({
            step: "create-routing-rule",
            status: "blocked",
            errorCode: blocked.errorCode,
            errorDetail: blocked.errorDetail,
          });
          await run.finish("partial", null);
          return { runId: run.runId, status: "partial", outcome: "write_policy_blocked" };
        }

        if (existing !== undefined) {
          await run.step({
            step: "create-routing-rule",
            status: "succeeded",
            responseSummary: { matchUser: input.matchUser, alreadyExists: true },
          });
          await run.finish("succeeded", null);
          return { runId: run.runId, status: "succeeded", outcome: "already_exists" };
        }

        try {
          await provider.createRoutingRule({
            domainName: domain.name,
            matchUser: input.matchUser,
            targetAddresses: input.targetAddresses,
            prefix: input.prefix,
            catchall,
          });
        } catch (error) {
          const kind = errorKind(error);
          await run.step({
            step: "create-routing-rule",
            status: "failed",
            errorCode: kind,
            errorDetail: "routing rule create failed",
            requestSummary: {
              operation: "mail.routing.create",
              domain: domain.name,
              matchUser: input.matchUser,
            },
          });
          await run.finish("failed", `routing rule create failed (${kind})`);
          throw new ProviderCallError(kind, "routing rule create failed", {
            domainId: domain.id,
            runId: run.runId,
          });
        }

        await run.step({
          step: "create-routing-rule",
          status: "succeeded",
          requestSummary: {
            operation: "mail.routing.create",
            domain: domain.name,
            matchUser: input.matchUser,
            catchall,
          },
          responseSummary: { created: true },
        });
        await run.finish("succeeded", null);
        return { runId: run.runId, status: "succeeded", outcome: "created" };
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        const message = error instanceof Error ? error.message : "routing rule create failed";
        await run.step({ step: "run", status: "failed", errorDetail: message });
        await run.finish("failed", message);
        throw error;
      }
    },

    async deleteRoutingRule(input) {
      const domain = await loadDomain(input.domainId);
      const run = await openRun(DELETE_ROUTING_RULE_RUN_KIND, input, domain.id);

      try {
        const rules = await provider.listRoutingRules();
        await run.step({
          step: "read-provider",
          status: "succeeded",
          requestSummary: { operation: "mail.routing.list", domain: domain.name },
          responseSummary: { rules: rules.length },
        });

        const found = rules.find(
          (rule) => rule.id === input.routingRuleId && rule.domainName === domain.name,
        );
        if (found === undefined) {
          // Idempotent no-op: nothing left to confirm against or delete.
          await run.step({
            step: "already-absent",
            status: "succeeded",
            responseSummary: { routingRuleId: input.routingRuleId, alreadyAbsent: true },
          });
          await run.finish("succeeded", null);
          return { runId: run.runId, status: "succeeded", outcome: "already_absent" };
        }

        const expected = `${found.matchUser}@${found.domainName}`;
        if (input.confirmationText !== expected) {
          throw new InfrastructureValidationError(
            `confirmation text did not match this rule's match pattern (expected "${expected}")`,
            { expected },
          );
        }

        const blocked = await checkWritePolicy(
          input.trigger,
          input.actorIsAdmin,
          2,
          "allow access-affecting writes for this Purelymail connection " +
            "(currently below that tier by policy) on /settings/connections to delete this routing rule",
        );
        if (blocked !== null) {
          await run.step({
            step: "delete-routing-rule",
            status: "blocked",
            errorCode: blocked.errorCode,
            errorDetail: blocked.errorDetail,
          });
          await run.finish("partial", null);
          return { runId: run.runId, status: "partial", outcome: "write_policy_blocked" };
        }

        // The Loxep intent side first, same ordering reason as deleteMailboxNow.
        const matchingRows = await db
          .select()
          .from(mailboxes)
          .where(
            and(
              eq(mailboxes.domainId, domain.id),
              eq(mailboxes.localPart, found.matchUser),
              inArray(mailboxes.kind, ["alias", "catchall"]),
            ),
          );
        const existing = matchingRows[0];
        if (existing !== undefined) {
          await mailDomains.removeMailbox(existing.id, {
            actorUserId: input.actorUserId ?? null,
          });
        }

        try {
          await provider.deleteRoutingRule(found.id);
        } catch (error) {
          const kind = errorKind(error);
          if (kind !== "not_found") {
            await run.step({
              step: "delete-routing-rule",
              status: "failed",
              errorCode: kind,
              errorDetail: "routing rule delete failed",
              requestSummary: {
                operation: "mail.routing.delete",
                matchUser: found.matchUser,
                domain: domain.name,
              },
            });
            await run.finish("failed", `routing rule delete failed (${kind})`);
            throw new ProviderCallError(kind, "routing rule delete failed", {
              domainId: domain.id,
              runId: run.runId,
            });
          }
          // The provider's own read-back already told us it exists; a
          // not_found here means it vanished between that read and this
          // call (a concurrent delete). Treated the same as "already gone".
        }

        if (existing !== undefined) {
          await db
            .update(mailboxes)
            .set({ providerCreatedAt: null, updatedAt: new Date() })
            .where(eq(mailboxes.id, existing.id));
        }

        await run.step({
          step: "delete-routing-rule",
          status: "succeeded",
          requestSummary: {
            operation: "mail.routing.delete",
            matchUser: found.matchUser,
            domain: domain.name,
          },
          responseSummary: { deleted: true },
        });
        await run.finish("succeeded", null);
        return { runId: run.runId, status: "succeeded", outcome: "deleted" };
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        const message = error instanceof Error ? error.message : "routing rule delete failed";
        await run.step({ step: "run", status: "failed", errorDetail: message });
        await run.finish("failed", message);
        throw error;
      }
    },
  };
}
