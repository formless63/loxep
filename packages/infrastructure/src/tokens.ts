/**
 * Minted per-host DNS tokens: mint, zone-scope intent, roll, and the policy
 * sync that pushes that intent to the provider (Phase 7 milestone 3,
 * loxep-lmy.3).
 *
 * ## HARD CONSTRAINT — minting is a REQUEST-SCOPED ADMIN ACTION, never a job
 *
 * ADR-0022 permits a minted secret's plaintext to be shown to the requesting
 * admin exactly once, **in the response to the creating action**. Milestone
 * 2 found the gap this milestone must not repeat: a mailbox password minted
 * inside a worker job has no requesting admin and no response to reveal
 * into, so `mailboxes.secret_id` shipped write-only from birth with rotation
 * as its only remedy.
 *
 * {@link DnsProviderTokensService.mint} and `.roll` are therefore designed to
 * be called **synchronously, from a server function handling one admin HTTP
 * request**, and to return the plaintext value directly in their own return
 * value. Neither function may be wrapped in a Graphile Worker task, neither
 * takes a `job_key`, and neither is listed in this package's job graph
 * (`tasks.ts`) — only {@link DnsProviderTokensService.syncPolicy}, the
 * genuinely idempotent, re-runnable half of this module, is. A caller that
 * enqueues a mint has broken the one guarantee that makes the reveal legal.
 *
 * ## Two provider behaviors this design must respect (the design's own words)
 *
 * 1. **The token value is returned exactly once, at creation** (mint) or at
 *    roll. Every subsequent read omits it. The value must be captured into an
 *    `application_secrets` version in the SAME transaction that writes the
 *    token row, or it is unrecoverable — see
 *    {@link TransactionalDnsTokenSecretWriter} in `token-port.ts` for how that
 *    atomicity is achieved through a nested savepoint rather than a second
 *    transaction.
 * 2. **A policy update REPLACES the entire policy array.** There is no
 *    "add one zone" call, so `dns_provider_token_zones` is INTENT and
 *    {@link DnsProviderTokensService.syncPolicy} rebuilds the whole policy
 *    from it every time.
 *
 * ## Scope editing and token rolling are NOT the same operation
 *
 * Changing a token's zone scope does not change its value: no redeployment,
 * no secret rotation on the affected host. Rolling changes the value and
 * requires touching every host that token was ever pasted into. This module
 * keeps them as genuinely separate functions with separate audit actions —
 * the `/infrastructure` UI must not present them as neighbours, and this
 * module's naming is the first place that discipline is enforced.
 *
 * ## Why `mint` is ledgered through `provider_operations` and `roll` is not
 *
 * A mint is a genuine, non-idempotent CREATE: minting twice for the same
 * `(hostingTargetId, name)` would leave two live tokens at the provider, one
 * of them orphaned. `provider_operations` guards exactly that — the same
 * discipline `mail-sync.ts` applies to `mail.domain.add`. Per design open
 * question 4, a token create is the one case read-back CANNOT resolve (there
 * is no way to ask the provider "is this the token from my crashed attempt"
 * without already knowing its id), so an ambiguous `pending` row resolves to
 * an operator decision, never a retry.
 *
 * A roll has no such duplicate-create hazard: it always targets an EXISTING,
 * uniquely identified token, and rolling again is always a safe, intentional
 * action — an admin who lost a rolled value has exactly one remedy, which is
 * to roll again. Ledgering it would block that remedy on a stale "already
 * succeeded" row, which is the opposite of what the ledger is for.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import {
  dnsProviderTokenZones,
  dnsProviderTokens,
  hostingTargets,
  managedDomains,
  reconcileRunSteps,
  reconcileRuns,
} from "@loxep/db/schema";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { TransactionalEnqueue } from "./domains.ts";
import {
  InfrastructureNotFoundError,
  InfrastructureValidationError,
  ProviderCallError,
} from "./errors.ts";
import {
  createProviderOperationsLedger,
  idempotencyKey,
  type ProviderOperationsLedger,
} from "./operations.ts";
import type { ResponseRedactor } from "./port.ts";
import type {
  DnsTokenProviderPort,
  TransactionalDnsTokenSecretWriter,
} from "./token-port.ts";

export type DnsProviderTokenRow = typeof dnsProviderTokens.$inferSelect;

/** `audit_events.resource_type` for this module. */
export const DNS_PROVIDER_TOKEN_RESOURCE_TYPE = "dns_provider_token";

/** Graphile task name, per the design's job graph. ONLY this one — see the module doc. */
export const SYNC_TOKEN_POLICY_TASK = "infrastructure.sync-token-policy";

/** `reconcile_runs.kind` for a policy sync. */
export const SYNC_TOKEN_POLICY_RUN_KIND = "sync-token-policy";

/**
 * `@loxep/jobs`' `jobKeyFor` shape, re-declared so this module does not depend
 * on the jobs runtime just to build a string. The design's job graph fixes
 * this key: `token:{id}:policy`.
 */
export function tokenJobKey(taskName: string, tokenId: string): string {
  return `${taskName}:token:${tokenId}`;
}

/**
 * `application_secrets.secret_key` for a minted token, following the design's
 * stated convention `infrastructure.dns_token.<dns_provider_tokens.id>`.
 */
export function dnsProviderTokenSecretKey(tokenId: string): string {
  return `infrastructure.dns_token.${tokenId}`;
}

const nameSchema = z.string().trim().min(1).max(200);

const mintSchema = z.strictObject({
  hostingTargetId: z.string().uuid(),
  dnsConnectionId: z.string().uuid(),
  name: nameSchema,
  /** Initial zone scope intent. May be empty; scope later via {@link DnsProviderTokensService.setZones}. */
  domainIds: z.array(z.string().uuid()).optional(),
  actorUserId: z.string().min(1).nullish(),
});
export type MintDnsProviderTokenInput = z.input<typeof mintSchema>;

const setZonesSchema = z.strictObject({
  domainIds: z.array(z.string().uuid()),
  actorUserId: z.string().min(1).nullish(),
});
export type SetDnsProviderTokenZonesInput = z.input<typeof setZonesSchema>;

/** What {@link DnsProviderTokensService.mint} and `.roll` return. `value` appears HERE ONLY. */
export interface RevealedDnsProviderToken {
  token: DnsProviderTokenRow;
  /**
   * The plaintext value. This is the ENTIRE reason this type exists rather
   * than reusing {@link DnsProviderTokenRow} — the row itself never carries
   * it. The caller (a request-scoped server function) must return this in its
   * own response and must not persist, log, or re-derive it.
   */
  value: string;
}

export interface SyncTokenPolicyResult {
  runId: string;
  status: "succeeded" | "failed";
  zoneCount: number;
  /** Domains requested for scope that have no `external_zone_id` yet, and were skipped. */
  skippedUnzoned: number;
}

export interface DnsProviderTokensService {
  mint(input: MintDnsProviderTokenInput): Promise<RevealedDnsProviderToken>;
  get(id: string): Promise<DnsProviderTokenRow>;
  listForTarget(hostingTargetId: string): Promise<DnsProviderTokenRow[]>;
  listZones(tokenId: string): Promise<string[]>;
  /** Replace the zone-scope INTENT and enqueue a policy sync. Cheap and instant. */
  setZones(
    tokenId: string,
    input: SetDnsProviderTokenZonesInput,
  ): Promise<{ domainIds: string[] }>;
  /** Regenerate the token's value at the provider. Deliberate and destructive. */
  roll(
    tokenId: string,
    options?: { actorUserId?: string | null },
  ): Promise<RevealedDnsProviderToken>;
  /** Rebuild the provider's policy from `dns_provider_token_zones`. The reconciler-facing op. */
  syncPolicy(
    tokenId: string,
    options?: {
      trigger?: "intent_change" | "sweep" | "manual" | "poll";
      actorUserId?: string | null;
      redact?: ResponseRedactor;
    },
  ): Promise<SyncTokenPolicyResult>;
}

/** Keeps only scalar fields — the same shape `mail-sync.ts`'s default uses. */
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

function errorKind(error: unknown): string {
  return error instanceof Error && "kind" in error
    ? String((error as { kind: unknown }).kind)
    : "provider_unavailable";
}

export function createDnsProviderTokensService(options: {
  db: LoxepDb;
  provider: DnsTokenProviderPort;
  secrets: TransactionalDnsTokenSecretWriter;
  /** `provider_operations.provider`, e.g. `cloudflare`. Defaults to `dns`. */
  providerName?: string;
  enqueue?: TransactionalEnqueue;
  ledger?: ProviderOperationsLedger;
}): DnsProviderTokensService {
  const { db, provider, secrets } = options;
  const providerName = options.providerName ?? "dns";
  const enqueue: TransactionalEnqueue =
    options.enqueue ?? (async () => undefined);
  const ledger = options.ledger ?? createProviderOperationsLedger({ db });

  async function requireToken(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<DnsProviderTokenRow> {
    const rows = await executor
      .select()
      .from(dnsProviderTokens)
      .where(eq(dnsProviderTokens.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`dns provider token ${id} not found`, {
        id,
      });
    }
    return row;
  }

  async function requireHostingTarget(
    executor: Pick<LoxepDb, "select">,
    id: string,
  ): Promise<typeof hostingTargets.$inferSelect> {
    const rows = await executor
      .select()
      .from(hostingTargets)
      .where(eq(hostingTargets.id, id));
    const row = rows[0];
    if (row === undefined) {
      throw new InfrastructureNotFoundError(`hosting target ${id} not found`, {
        id,
      });
    }
    return row;
  }

  /** Resolve domain ids to their provider zone ids, skipping domains with none yet. */
  async function resolveZoneExternalIds(
    executor: Pick<LoxepDb, "select">,
    domainIds: readonly string[],
  ): Promise<{ zoneExternalIds: string[]; skippedUnzoned: number }> {
    if (domainIds.length === 0) return { zoneExternalIds: [], skippedUnzoned: 0 };
    const rows = await executor
      .select({
        id: managedDomains.id,
        externalZoneId: managedDomains.externalZoneId,
      })
      .from(managedDomains)
      .where(inArray(managedDomains.id, [...domainIds]));
    const found = new Map(rows.map((row) => [row.id, row.externalZoneId]));
    for (const domainId of domainIds) {
      if (!found.has(domainId)) {
        throw new InfrastructureNotFoundError(
          `managed domain ${domainId} not found`,
          { domainId },
        );
      }
    }
    const zoneExternalIds: string[] = [];
    let skippedUnzoned = 0;
    for (const externalZoneId of found.values()) {
      if (externalZoneId === null) {
        skippedUnzoned += 1;
        continue;
      }
      zoneExternalIds.push(externalZoneId);
    }
    return { zoneExternalIds, skippedUnzoned };
  }

  return {
    async mint(input) {
      const parsed = mintSchema.parse(input);
      const domainIds = parsed.domainIds ?? [];

      const hostingTarget = await requireHostingTarget(
        db,
        parsed.hostingTargetId,
      );
      if (hostingTarget.decommissionedAt !== null) {
        throw new InfrastructureValidationError(
          `hosting target "${hostingTarget.name}" is decommissioned; cannot mint a token for it`,
          { hostingTargetId: parsed.hostingTargetId },
        );
      }
      const { zoneExternalIds } = await resolveZoneExternalIds(db, domainIds);

      // The natural key: minting twice with the same (host, name) is almost
      // certainly a retried request, not two intentional tokens — a UI that
      // wants two tokens for one host must give them different names.
      const key = idempotencyKey(
        providerName,
        "dns.token.mint",
        `${parsed.hostingTargetId}:${parsed.name}`,
      );
      const begin = await ledger.begin({
        key,
        provider: providerName,
        operation: "dns.token.mint",
      });

      if (begin.decision === "already_succeeded") {
        // The one case this module refuses outright: the value was already
        // revealed once, and ADR-0022 clause 2 forbids ever showing it again.
        // The remedy is `roll`, not a re-mint under the same name.
        throw new InfrastructureValidationError(
          `a token named "${parsed.name}" for this host was already minted; its value cannot be shown again — roll it if the value was lost`,
          { hostingTargetId: parsed.hostingTargetId, name: parsed.name },
        );
      }
      if (begin.decision === "needs_read_back") {
        // Open question 4: a token create is NOT read-back resolvable — there
        // is no way to ask the provider "is this the token my crashed attempt
        // made" without already knowing its id. Per the design's own
        // resolution, this becomes an operator decision, not a retry.
        await ledger.fail(key, {
          readBack: "not_supported",
          reason: "token creation has no readable natural identity",
        });
        throw new InfrastructureValidationError(
          `a previous mint attempt named "${parsed.name}" for this host is in an unknown state; check the provider dashboard for an orphaned token before retrying with a different name`,
          { hostingTargetId: parsed.hostingTargetId, name: parsed.name },
        );
      }

      let minted: { externalTokenId: string; value: string };
      try {
        minted = await provider.mintToken({
          name: parsed.name,
          permissionScope: "dns_edit",
          zoneExternalIds,
        });
      } catch (error) {
        const kind = errorKind(error);
        await ledger.fail(key, { errorKind: kind });
        if (error instanceof ProviderCallError) throw error;
        throw new ProviderCallError(kind, "dns token mint failed", {
          hostingTargetId: parsed.hostingTargetId,
        });
      }

      // THE atomic step: token row + secret version, in ONE transaction, or
      // the value is unrecoverable. See token-port.ts for how the nested
      // secrets-service call becomes a savepoint rather than a second
      // transaction.
      const { row, secretId } = await db.transaction(async (tx) => {
        const secret = await secrets(tx, {
          secretKey: dnsProviderTokenSecretKey(minted.externalTokenId),
          purpose: "dns_edit_token",
          payload: { token: minted.value },
          actorUserId: parsed.actorUserId ?? null,
        });

        const inserted = await tx
          .insert(dnsProviderTokens)
          .values({
            hostingTargetId: parsed.hostingTargetId,
            dnsConnectionId: parsed.dnsConnectionId,
            externalTokenId: minted.externalTokenId,
            name: parsed.name,
            permissionScope: "dns_edit",
            secretId: secret.id,
          })
          .returning();
        const insertedRow = inserted[0];
        if (insertedRow === undefined) {
          throw new Error("dns provider token insert returned no row");
        }

        for (const domainId of domainIds) {
          await tx
            .insert(dnsProviderTokenZones)
            .values({ tokenId: insertedRow.id, domainId })
            .onConflictDoNothing();
        }

        const audit = createAuditService({ db: tx });
        await audit.append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.dns_provider_token.mint",
          resourceType: DNS_PROVIDER_TOKEN_RESOURCE_TYPE,
          resourceId: insertedRow.id,
          after: {
            name: insertedRow.name,
            hostingTargetId: insertedRow.hostingTargetId,
            permissionScope: insertedRow.permissionScope,
            zoneCount: domainIds.length,
          },
        });
        // ADR-0022 clause 3: every reveal is audited, in the same transaction
        // that stores the ciphertext — before the caller ever sees the value.
        await audit.append({
          actorUserId: parsed.actorUserId ?? null,
          action: "secret.reveal_once",
          resourceType: "application_secret",
          resourceId: secret.id,
          metadata: {
            purpose: "dns_edit_token",
            secretKey: dnsProviderTokenSecretKey(minted.externalTokenId),
            tokenId: insertedRow.id,
          },
        });

        if (domainIds.length > 0) {
          await enqueue(
            tx,
            SYNC_TOKEN_POLICY_TASK,
            { tokenId: insertedRow.id },
            { jobKey: tokenJobKey(SYNC_TOKEN_POLICY_TASK, insertedRow.id) },
          );
        }

        return { row: insertedRow, secretId: secret.id };
      });

      await ledger.succeed(key, {
        tokenId: row.id,
        secretId,
        // NEVER the value. See the module and table doc — this is the single
        // highest-risk line in the design.
      });

      return { token: row, value: minted.value };
    },

    async get(id) {
      return requireToken(db, id);
    },

    async listForTarget(hostingTargetId) {
      return db
        .select()
        .from(dnsProviderTokens)
        .where(eq(dnsProviderTokens.hostingTargetId, hostingTargetId));
    },

    async listZones(tokenId) {
      const rows = await db
        .select({ domainId: dnsProviderTokenZones.domainId })
        .from(dnsProviderTokenZones)
        .where(eq(dnsProviderTokenZones.tokenId, tokenId));
      return rows.map((row) => row.domainId);
    },

    async setZones(tokenId, input) {
      const parsed = setZonesSchema.parse(input);
      await resolveZoneExternalIds(db, parsed.domainIds); // validates existence only

      return db.transaction(async (tx) => {
        const token = await requireToken(tx, tokenId);

        const before = await tx
          .select({ domainId: dnsProviderTokenZones.domainId })
          .from(dnsProviderTokenZones)
          .where(eq(dnsProviderTokenZones.tokenId, tokenId));
        const beforeIds = before.map((row) => row.domainId);

        // A full REPLACE of the intent set, matching the provider's own
        // "policy update replaces the whole array" behavior one level up.
        await tx
          .delete(dnsProviderTokenZones)
          .where(eq(dnsProviderTokenZones.tokenId, tokenId));
        for (const domainId of parsed.domainIds) {
          await tx.insert(dnsProviderTokenZones).values({ tokenId, domainId });
        }

        await createAuditService({ db: tx }).append({
          actorUserId: parsed.actorUserId ?? null,
          action: "infrastructure.dns_provider_token.set_zones",
          resourceType: DNS_PROVIDER_TOKEN_RESOURCE_TYPE,
          resourceId: tokenId,
          before: { domainCount: beforeIds.length },
          after: { domainCount: parsed.domainIds.length },
        });

        // Cheap and instant, per the design: no redeployment, no value
        // change. `replace` mode is right — the newest intent should sync
        // now, not wait behind whatever backoff a prior poll left.
        await enqueue(
          tx,
          SYNC_TOKEN_POLICY_TASK,
          { tokenId: token.id },
          { jobKey: tokenJobKey(SYNC_TOKEN_POLICY_TASK, token.id) },
        );

        return { domainIds: parsed.domainIds };
      });
    },

    async roll(tokenId, rollOptions) {
      const token = await requireToken(db, tokenId);

      let rolled: { value: string };
      try {
        rolled = await provider.rollToken(token.externalTokenId);
      } catch (error) {
        const kind = errorKind(error);
        if (error instanceof ProviderCallError) throw error;
        throw new ProviderCallError(kind, "dns token roll failed", {
          tokenId,
        });
      }

      const row = await db.transaction(async (tx) => {
        // setSecret under the SAME secret_key is a ROTATION (a new version,
        // same logical secret) — the same primitive `mail-sync.ts` would use
        // if a mailbox password ever needed one, applied here where a request
        // is actually waiting for the response.
        const secret = await secrets(tx, {
          secretKey: dnsProviderTokenSecretKey(token.externalTokenId),
          purpose: "dns_edit_token",
          payload: { token: rolled.value },
          actorUserId: rollOptions?.actorUserId ?? null,
        });

        const updated = await tx
          .update(dnsProviderTokens)
          .set({
            secretId: secret.id,
            lastRolledAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(dnsProviderTokens.id, tokenId))
          .returning();
        const updatedRow = updated[0];
        if (updatedRow === undefined) {
          throw new Error("dns provider token update returned no row");
        }

        const audit = createAuditService({ db: tx });
        await audit.append({
          actorUserId: rollOptions?.actorUserId ?? null,
          action: "infrastructure.dns_provider_token.roll",
          resourceType: DNS_PROVIDER_TOKEN_RESOURCE_TYPE,
          resourceId: tokenId,
          after: { lastRolledAt: updatedRow.lastRolledAt },
        });
        await audit.append({
          actorUserId: rollOptions?.actorUserId ?? null,
          action: "secret.reveal_once",
          resourceType: "application_secret",
          resourceId: secret.id,
          metadata: {
            purpose: "dns_edit_token",
            secretKey: dnsProviderTokenSecretKey(token.externalTokenId),
            tokenId,
            reason: "roll",
          },
        });

        return updatedRow;
      });

      return { token: row, value: rolled.value };
    },

    async syncPolicy(tokenId, syncOptions) {
      const redact = syncOptions?.redact ?? defaultRedactor;
      const token = await requireToken(db, tokenId);
      const domainIds = await db
        .select({ domainId: dnsProviderTokenZones.domainId })
        .from(dnsProviderTokenZones)
        .where(eq(dnsProviderTokenZones.tokenId, tokenId))
        .then((rows) => rows.map((row) => row.domainId));

      const { zoneExternalIds, skippedUnzoned } = await resolveZoneExternalIds(
        db,
        domainIds,
      );

      const runRows = await db
        .insert(reconcileRuns)
        .values({
          kind: SYNC_TOKEN_POLICY_RUN_KIND,
          subjectType: "token",
          subjectId: tokenId,
          mode: "apply",
          trigger: syncOptions?.trigger ?? "intent_change",
          actorUserId: syncOptions?.actorUserId ?? null,
        })
        .returning();
      const run = runRows[0];
      if (run === undefined) throw new Error("reconcile run insert returned no row");

      try {
        await provider.updatePolicy(token.externalTokenId, zoneExternalIds);
      } catch (error) {
        const kind = errorKind(error);
        await db.insert(reconcileRunSteps).values({
          runId: run.id,
          sequence: 0,
          step: "update-policy",
          status: "failed",
          provider: providerName,
          errorCode: kind,
          errorDetail: "dns token policy sync failed",
        });
        await db
          .update(reconcileRuns)
          .set({
            status: "failed",
            finishedAt: new Date(),
            stepCount: 1,
            errorSummary: `policy sync failed (${kind})`,
          })
          .where(eq(reconcileRuns.id, run.id));
        if (error instanceof ProviderCallError) throw error;
        throw new ProviderCallError(kind, "dns token policy sync failed", {
          tokenId,
          runId: run.id,
        });
      }

      await db.insert(reconcileRunSteps).values({
        runId: run.id,
        sequence: 0,
        step: "update-policy",
        status: "succeeded",
        provider: providerName,
        requestSummary: redact({
          operation: "dns.token.updatePolicy",
          zoneCount: zoneExternalIds.length,
        }),
        responseSummary: redact({ zoneCount: zoneExternalIds.length }),
      });
      await db
        .update(reconcileRuns)
        .set({ status: "succeeded", finishedAt: new Date(), stepCount: 1 })
        .where(eq(reconcileRuns.id, run.id));
      await db
        .update(dnsProviderTokens)
        .set({ policySyncedAt: new Date(), updatedAt: new Date() })
        .where(eq(dnsProviderTokens.id, tokenId));

      return {
        runId: run.id,
        status: "succeeded",
        zoneCount: zoneExternalIds.length,
        skippedUnzoned,
      };
    },
  };
}
