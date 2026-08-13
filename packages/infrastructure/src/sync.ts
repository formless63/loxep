/**
 * `runRecordSync` — the database-driven reconcile run: intent -> provider read
 * -> diff -> (apply) -> findings, recorded step by step in `reconcile_runs` and
 * `reconcile_run_steps`.
 *
 * The pure halves live elsewhere on purpose: `materialize.ts` decides what
 * should exist, `reconcile.ts` decides what differs, and this module is the
 * only one that touches both a database and a provider. Keeping the orchestrator
 * separate is what lets the diff be exhaustively tested with no I/O at all.
 *
 * ## `mode` is one code path and a stored fact
 *
 * ```text
 * mode = 'apply'   read -> diff -> apply -> findings, resolved 'applied'
 * mode = 'check'   read -> diff ->       -> findings
 * ```
 *
 * The only branch is whether `provider.apply` is called. Everything before and
 * after it is shared, which is why a check run's findings can be trusted to
 * describe what an apply run would have done.
 *
 * ## What is recorded, and what must never be
 *
 * `reconcile_run_steps.request_summary` and `response_summary` are REDACTED
 * structures produced by a per-adapter redactor injected by the composition
 * root. This module accepts a {@link ResponseRedactor} and never sees a raw
 * provider payload, so it has no way to write one. A token value, a mailbox
 * password, an `Authorization` header, or a credential-bearing URL cannot
 * reach these rows.
 *
 * ## At-least-once, and what makes a rerun safe
 *
 * - the provider read is a read;
 * - the diff is pure;
 * - apply operations are convergent — the adapter reports a replayed create as
 *   `already_present` and a replayed delete as `already_absent`;
 * - findings upsert against the unresolved partial unique;
 * - the run row is new each time, which is correct: two runs really did happen.
 *
 * A crash between the provider call and the database write therefore costs a
 * duplicate run row and nothing else. `provider_operations` exists for the
 * calls where that is NOT true (zone create, token create) — none of which
 * this milestone's record sync makes.
 */
import type { LoxepDb } from "@loxep/db";
import {
  dnsRecords,
  managedDomains,
  reconcileRunSteps,
  reconcileRuns,
} from "@loxep/db/schema";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createDriftService, findingsFromDiff } from "./drift.ts";
import { InfrastructureNotFoundError, ProviderCallError } from "./errors.ts";
import type { DnsProviderPort, ResponseRedactor } from "./port.ts";
import {
  applyOperationsFor,
  assertNoUnexpectedDeletions,
  diffDnsRecords,
  type DnsDiff,
  type IntentRecord,
} from "./reconcile.ts";

export type ReconcileRunRow = typeof reconcileRuns.$inferSelect;

export interface RunRecordSyncInput {
  domainId: string;
  mode: "apply" | "check";
  trigger: "intent_change" | "sweep" | "manual" | "poll";
  actorUserId?: string | null;
  /** Defaults to a pass-through that keeps only scalar fields. */
  redact?: ResponseRedactor;
}

export interface RunRecordSyncResult {
  runId: string;
  status: "succeeded" | "failed" | "partial";
  mode: "apply" | "check";
  diff: DnsDiff;
  applied: number;
  unresolvedFindings: number;
  disappearedFindings: number;
}

/**
 * The default redactor: keep scalars, drop everything structured. Deliberately
 * conservative, because the composition root is supposed to inject the
 * adapter's own redactor and this fallback exists only so a caller that forgets
 * degrades to less information rather than to a leak.
 */
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

export interface RecordSyncService {
  run(input: RunRecordSyncInput): Promise<RunRecordSyncResult>;
  listRuns(subjectId: string): Promise<ReconcileRunRow[]>;
}

export function createRecordSyncService(options: {
  db: LoxepDb;
  provider: DnsProviderPort;
}): RecordSyncService {
  const { db, provider } = options;
  const drift = createDriftService({ db });

  return {
    async run(input) {
      const redact = input.redact ?? defaultRedactor;

      const domainRows = await db
        .select()
        .from(managedDomains)
        .where(eq(managedDomains.id, input.domainId));
      const domain = domainRows[0];
      if (domain === undefined) {
        throw new InfrastructureNotFoundError(
          `managed domain ${input.domainId} not found`,
          { domainId: input.domainId },
        );
      }
      if (domain.externalZoneId === null) {
        throw new InfrastructureNotFoundError(
          `managed domain "${domain.name}" has no provider zone yet`,
          { domainId: domain.id, state: domain.state },
        );
      }
      const zone = {
        externalZoneId: domain.externalZoneId,
        zoneName: domain.name,
      };

      const runRows = await db
        .insert(reconcileRuns)
        .values({
          kind: "sync-records",
          subjectType: "domain",
          subjectId: domain.id,
          mode: input.mode,
          trigger: input.trigger,
          actorUserId: input.actorUserId ?? null,
        })
        .returning();
      const run = runRows[0];
      if (run === undefined) throw new Error("reconcile run insert returned no row");

      let sequence = 0;
      const step = async (entry: {
        step: string;
        status: "succeeded" | "failed" | "skipped";
        requestSummary?: Record<string, unknown> | null;
        responseSummary?: Record<string, unknown> | null;
        errorCode?: string | null;
        errorDetail?: string | null;
      }): Promise<void> => {
        await db.insert(reconcileRunSteps).values({
          runId: run.id,
          sequence: sequence++,
          step: entry.step,
          status: entry.status,
          provider: "dns",
          requestSummary: entry.requestSummary ?? null,
          responseSummary: entry.responseSummary ?? null,
          errorCode: entry.errorCode ?? null,
          errorDetail: entry.errorDetail ?? null,
        });
      };

      const finish = async (
        status: "succeeded" | "failed" | "partial",
        errorSummary: string | null,
      ): Promise<void> => {
        await db
          .update(reconcileRuns)
          .set({
            status,
            finishedAt: new Date(),
            stepCount: sequence,
            errorSummary,
          })
          .where(eq(reconcileRuns.id, run.id));
      };

      try {
        // ---- intent -------------------------------------------------------
        const liveRows = await db
          .select()
          .from(dnsRecords)
          .where(
            and(
              eq(dnsRecords.domainId, domain.id),
              isNull(dnsRecords.desiredDeletedAt),
            ),
          );
        const intent: IntentRecord[] = liveRows.map((row) => ({
          id: row.id,
          type: row.type,
          name: row.name,
          content: row.content,
          ttlSeconds: row.ttlSeconds,
          priority: row.priority,
          proxied: row.proxied,
          owner: row.owner as IntentRecord["owner"],
          externalRecordId: row.externalRecordId,
        }));

        const tombstoneRows = await db
          .select()
          .from(dnsRecords)
          .where(
            and(
              eq(dnsRecords.domainId, domain.id),
              isNotNull(dnsRecords.desiredDeletedAt),
            ),
          );

        await step({
          step: "read-intent",
          status: "succeeded",
          responseSummary: {
            live: intent.length,
            tombstones: tombstoneRows.length,
          },
        });

        // ---- observed -----------------------------------------------------
        let observed;
        try {
          observed = await provider.read(zone);
        } catch (error) {
          const kind =
            error instanceof Error && "kind" in error
              ? String((error as { kind: unknown }).kind)
              : "provider_unavailable";
          await step({
            step: "read-provider",
            status: "failed",
            errorCode: kind,
            errorDetail:
              error instanceof Error ? error.message : "provider read failed",
          });
          await finish("failed", `provider read failed (${kind})`);
          await db
            .update(managedDomains)
            .set({
              lastErrorAt: new Date(),
              lastErrorCode: kind,
              consecutiveErrors: domain.consecutiveErrors + 1,
              updatedAt: new Date(),
            })
            .where(eq(managedDomains.id, domain.id));
          throw new ProviderCallError(kind, "provider read failed", {
            domainId: domain.id,
            runId: run.id,
          });
        }
        await step({
          step: "read-provider",
          status: "succeeded",
          requestSummary: { operation: "dns.records.list", zone: domain.name },
          responseSummary: { observed: observed.length },
        });

        // ---- pending removals ---------------------------------------------
        // A record Loxep SOFT-DELETED and that still exists at the provider is
        // not drift and is emphatically not `unexpected`: intent describes it,
        // and what intent says is "remove this". Pairing tombstones off the
        // observed set BEFORE the diff is what keeps open question 3's
        // never-delete-an-unexpected-record rule from colliding with a
        // legitimate removal. (Found by a test, not by review: without this,
        // every soft delete tripped the guard.)
        const observedByKey = new Map(
          observed.map((record) => [
            `${record.type} ${record.name} ${record.content}`,
            record,
          ]),
        );
        const tombstones = tombstoneRows.flatMap((row) => {
          const match = observedByKey.get(`${row.type} ${row.name} ${row.content}`);
          if (match === undefined) return [];
          return [
            {
              intent: {
                id: row.id,
                type: row.type,
                name: row.name,
                content: row.content,
                ttlSeconds: row.ttlSeconds,
                priority: row.priority,
                proxied: row.proxied,
                owner: row.owner as IntentRecord["owner"],
                externalRecordId: row.externalRecordId,
              },
              observed: match,
            },
          ];
        });
        const pendingRemovalIds = new Set(
          tombstones.map((entry) => entry.observed.externalRecordId),
        );
        const observedForDiff = observed.filter(
          (record) => !pendingRemovalIds.has(record.externalRecordId),
        );

        // ---- diff ---------------------------------------------------------
        const diff = diffDnsRecords(intent, observedForDiff);
        await step({
          step: "diff",
          status: "succeeded",
          responseSummary: {
            missing: diff.missing.length,
            modified: diff.modified.length,
            unexpected: diff.unexpected.length,
            unchanged: diff.unchanged.length,
            // Reported rather than hidden: in `check` mode these are the
            // removals an `apply` run would have made.
            pendingRemovals: tombstones.length,
          },
        });

        // ---- apply (or not) -----------------------------------------------
        let applied = 0;
        if (input.mode === "apply") {
          const operations = applyOperationsFor(diff, tombstones);
          // Belt and braces around open question 3: even if a future edit
          // added unexpected records to the operation builder, this throws
          // rather than deleting.
          assertNoUnexpectedDeletions(diff, operations);

          if (operations.length > 0) {
            const results = await provider.apply({ ...zone, operations });
            applied = results.length;
            for (const result of results) {
              await step({
                step: `apply.${result.kind}`,
                status: "succeeded",
                requestSummary: {
                  operation: result.kind,
                  type: result.type,
                  name: result.name,
                },
                responseSummary: redact(result),
              });
            }

            // Capture the provider ids a create just produced, so the next
            // update or delete is a single call rather than a search.
            for (const result of results) {
              if (result.externalRecordId === null) continue;
              await db
                .update(dnsRecords)
                .set({
                  externalRecordId: result.externalRecordId,
                  lastSyncedAt: new Date(),
                })
                .where(
                  and(
                    eq(dnsRecords.domainId, domain.id),
                    eq(dnsRecords.type, result.type),
                    eq(dnsRecords.name, result.name),
                  ),
                );
            }
          } else {
            await step({ step: "apply.none", status: "skipped" });
          }
        } else {
          // The stored `mode` is what tells a later reader that this run found
          // three differences and deliberately fixed none of them.
          await step({ step: "apply.skipped-check-mode", status: "skipped" });
        }

        // ---- findings -----------------------------------------------------
        // Findings are recorded in BOTH modes, from the same diff. An apply run
        // records what it found and then resolves it as 'applied', so the
        // history of what was wrong survives the fix.
        const findings = findingsFromDiff(diff);
        const recorded = await drift.recordRun({
          domainId: domain.id,
          runId: run.id,
          findings,
        });

        if (input.mode === "apply") {
          const unresolved = await drift.listUnresolved(domain.id);
          // Everything except `unexpected`: those are NEVER resolved by an
          // apply, because an apply never touches them.
          const fixed = unresolved
            .filter((finding) => finding.kind !== "unexpected")
            .map((finding) => finding.id);
          await drift.markApplied(fixed);
        }

        await step({
          step: "record-findings",
          status: "succeeded",
          responseSummary: {
            recorded: findings.length,
            unresolved: recorded.unresolved,
            disappeared: recorded.disappeared,
          },
        });

        await db
          .update(managedDomains)
          .set({
            lastErrorAt: null,
            lastErrorCode: null,
            consecutiveErrors: 0,
            updatedAt: new Date(),
          })
          .where(eq(managedDomains.id, domain.id));

        await finish("succeeded", null);

        return {
          runId: run.id,
          status: "succeeded",
          mode: input.mode,
          diff,
          applied,
          unresolvedFindings: recorded.unresolved,
          disappearedFindings: recorded.disappeared,
        };
      } catch (error) {
        if (error instanceof ProviderCallError) throw error;
        const message =
          error instanceof Error ? error.message : "reconcile run failed";
        await step({
          step: "run",
          status: "failed",
          errorDetail: message,
        });
        await finish("failed", message);
        throw error;
      }
    },

    async listRuns(subjectId) {
      return db
        .select()
        .from(reconcileRuns)
        .where(
          and(
            eq(reconcileRuns.subjectType, "domain"),
            eq(reconcileRuns.subjectId, subjectId),
          ),
        );
    },
  };
}
