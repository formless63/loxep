/**
 * `dns_drift_findings` — persisting the desired-versus-observed output.
 *
 * The reason this is a table rather than a log line, restated because it is
 * the decision the whole drift model rests on: **an `unexpected` record has no
 * `dns_records` row to hang off.** A record present at the provider that
 * intent never described is the single most important drift class, because it
 * is how a hand-edit in a provider dashboard becomes visible, and columns on
 * the intent row structurally cannot represent it.
 *
 * ## Findings are UPSERTED against the unresolved partial unique
 *
 * ```sql
 * unique(domain_id, kind, record_type, record_name, coalesce(observed_content,''))
 *   where resolved_at is null
 * ```
 *
 * That index is what makes an hourly sweep idempotent: the second detection of
 * the same drift updates `last_detected_at` and `last_seen_run_id` rather than
 * inserting a duplicate. `first_detected_at` therefore answers "how long has
 * this been wrong", which is the question an operator actually asks.
 *
 * ## Resolution is never a silent delete
 *
 * A finding whose condition no longer holds is resolved with
 * `resolution = 'disappeared'` by the next run that does not observe it,
 * because "this drift went away on its own" is itself worth knowing.
 *
 * ## `unexpected` records are never deleted automatically
 *
 * Open question 3, PROVISIONAL: hold that line permanently. The resolutions an
 * operator may choose are `adopted` (write the observed value into
 * `dns_records` as `owner='manual'`, so the drift disappears because intent
 * caught up with reality rather than because reality was overwritten),
 * `dismissed`, or an explicit, separate delete action. Nothing in this module
 * deletes anything at a provider — it has no provider port at all, which is
 * the structural version of the rule.
 */
import { createAuditService } from "@loxep/domain";
import type { LoxepDb } from "@loxep/db";
import { dnsDriftFindings, managedDomains } from "@loxep/db/schema";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { InfrastructureNotFoundError } from "./errors.ts";
import type { DnsDiff } from "./reconcile.ts";

export type DnsDriftFindingRow = typeof dnsDriftFindings.$inferSelect;

/** What one detected finding looks like before it reaches the database. */
export interface DriftFindingInput {
  kind: "missing" | "modified" | "unexpected";
  recordType: string;
  recordName: string;
  desiredContent: string | null;
  observedContent: string | null;
  desiredProxied: boolean | null;
  observedProxied: boolean | null;
  externalRecordId: string | null;
  /** NULL exactly when `kind = 'unexpected'` — the schema enforces it too. */
  dnsRecordId: string | null;
}

/**
 * Turn a diff into findings. Pure, so the mapping is testable without a
 * database and so `mode` cannot accidentally change what gets reported —
 * `apply` and `check` produce the same findings from the same diff.
 *
 * `unchanged` entries produce nothing, deliberately: a table of "this is
 * fine" rows would bury the ones that are not.
 */
export function findingsFromDiff(diff: DnsDiff): DriftFindingInput[] {
  const findings: DriftFindingInput[] = [];

  for (const entry of diff.missing) {
    findings.push({
      kind: "missing",
      recordType: entry.intent.type,
      recordName: entry.intent.name,
      desiredContent: entry.intent.content,
      observedContent: null,
      desiredProxied: entry.intent.proxied,
      observedProxied: null,
      externalRecordId: null,
      dnsRecordId: entry.intent.id,
    });
  }

  for (const entry of diff.modified) {
    findings.push({
      kind: "modified",
      recordType: entry.intent.type,
      recordName: entry.intent.name,
      desiredContent: entry.intent.content,
      observedContent: entry.observed.content,
      desiredProxied: entry.intent.proxied,
      observedProxied: entry.observed.proxied,
      externalRecordId: entry.observed.externalRecordId,
      dnsRecordId: entry.intent.id,
    });
  }

  for (const entry of diff.unexpected) {
    findings.push({
      kind: "unexpected",
      recordType: entry.observed.type,
      recordName: entry.observed.name,
      desiredContent: null,
      observedContent: entry.observed.content,
      desiredProxied: null,
      observedProxied: entry.observed.proxied,
      externalRecordId: entry.observed.externalRecordId,
      // The class that cannot be a column on the intent row.
      dnsRecordId: null,
    });
  }

  return findings;
}

export interface DriftService {
  /**
   * Upsert every finding this run detected and resolve as `disappeared` every
   * previously unresolved finding this run did NOT detect. Returns the
   * unresolved count, which is what `managed_domains.drift_detected_at` and
   * the sweep's `infraSync` state are derived from.
   */
  recordRun(input: {
    domainId: string;
    runId: string;
    findings: readonly DriftFindingInput[];
  }): Promise<{ unresolved: number; disappeared: number }>;

  listUnresolved(domainId: string): Promise<DnsDriftFindingRow[]>;

  /** Acknowledge a finding without changing anything at the provider. */
  dismiss(
    findingId: string,
    options?: { actorUserId?: string | null },
  ): Promise<DnsDriftFindingRow>;

  /**
   * Mark a finding resolved because an `apply` run fixed it. Called by the
   * reconciler, never by a UI.
   */
  markApplied(findingIds: readonly string[]): Promise<number>;
}

export function createDriftService(options: { db: LoxepDb }): DriftService {
  const { db } = options;

  return {
    async recordRun({ domainId, runId, findings }) {
      const now = new Date();

      return db.transaction(async (tx) => {
        const survivingIds: string[] = [];

        for (const finding of findings) {
          // The upsert probe is the unresolved partial unique, which Drizzle
          // cannot name as a conflict target (it is an expression index), so
          // the probe is written explicitly: find the unresolved twin, update
          // it, otherwise insert.
          const existing = await tx
            .select()
            .from(dnsDriftFindings)
            .where(
              and(
                eq(dnsDriftFindings.domainId, domainId),
                eq(dnsDriftFindings.kind, finding.kind),
                eq(dnsDriftFindings.recordType, finding.recordType),
                eq(dnsDriftFindings.recordName, finding.recordName),
                sql`coalesce(${dnsDriftFindings.observedContent}, '') = ${finding.observedContent ?? ""}`,
                isNull(dnsDriftFindings.resolvedAt),
              ),
            );

          const found = existing[0];
          if (found !== undefined) {
            // Second detection: `first_detected_at` is left alone on purpose —
            // it is the answer to "how long has this been wrong".
            await tx
              .update(dnsDriftFindings)
              .set({
                lastDetectedAt: now,
                lastSeenRunId: runId,
                desiredContent: finding.desiredContent,
                desiredProxied: finding.desiredProxied,
                observedProxied: finding.observedProxied,
                externalRecordId: finding.externalRecordId,
              })
              .where(eq(dnsDriftFindings.id, found.id));
            survivingIds.push(found.id);
            continue;
          }

          const inserted = await tx
            .insert(dnsDriftFindings)
            .values({
              domainId,
              dnsRecordId: finding.dnsRecordId,
              kind: finding.kind,
              recordType: finding.recordType,
              recordName: finding.recordName,
              desiredContent: finding.desiredContent,
              observedContent: finding.observedContent,
              desiredProxied: finding.desiredProxied,
              observedProxied: finding.observedProxied,
              externalRecordId: finding.externalRecordId,
              firstDetectedAt: now,
              lastDetectedAt: now,
              firstSeenRunId: runId,
              lastSeenRunId: runId,
            })
            .returning({ id: dnsDriftFindings.id });
          const row = inserted[0];
          if (row !== undefined) survivingIds.push(row.id);
        }

        // Anything unresolved that this run did not see has gone away.
        const disappearedRows = await tx
          .update(dnsDriftFindings)
          .set({
            resolvedAt: now,
            resolution: "disappeared",
            lastSeenRunId: runId,
          })
          .where(
            and(
              eq(dnsDriftFindings.domainId, domainId),
              isNull(dnsDriftFindings.resolvedAt),
              survivingIds.length === 0
                ? sql`true`
                : notInArray(dnsDriftFindings.id, survivingIds),
            ),
          )
          .returning({ id: dnsDriftFindings.id });

        // The denormalized rollup the domain list renders a badge from. It is
        // derived and recomputable; the findings table stays authoritative.
        await tx
          .update(managedDomains)
          .set({
            driftDetectedAt: survivingIds.length > 0 ? now : null,
            lastReconciledAt: now,
            updatedAt: now,
          })
          .where(eq(managedDomains.id, domainId));

        return {
          unresolved: survivingIds.length,
          disappeared: disappearedRows.length,
        };
      });
    },

    async listUnresolved(domainId) {
      return db
        .select()
        .from(dnsDriftFindings)
        .where(
          and(
            eq(dnsDriftFindings.domainId, domainId),
            isNull(dnsDriftFindings.resolvedAt),
          ),
        );
    },

    async dismiss(findingId, dismissOptions) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .update(dnsDriftFindings)
          .set({
            resolvedAt: new Date(),
            resolution: "dismissed",
            resolvedByUserId: dismissOptions?.actorUserId ?? null,
          })
          .where(eq(dnsDriftFindings.id, findingId))
          .returning();
        const row = rows[0];
        if (row === undefined) {
          throw new InfrastructureNotFoundError(
            `drift finding ${findingId} not found`,
            { findingId },
          );
        }

        await createAuditService({ db: tx }).append({
          actorUserId: dismissOptions?.actorUserId ?? null,
          action: "infrastructure.dns_drift_finding.dismiss",
          resourceType: "managed_domain",
          resourceId: row.domainId,
          after: {
            findingId: row.id,
            kind: row.kind,
            recordType: row.recordType,
            recordName: row.recordName,
          },
        });

        return row;
      });
    },

    async markApplied(findingIds) {
      if (findingIds.length === 0) return 0;
      const rows = await db
        .update(dnsDriftFindings)
        .set({ resolvedAt: new Date(), resolution: "applied" })
        .where(inArray(dnsDriftFindings.id, [...findingIds]))
        .returning({ id: dnsDriftFindings.id });
      return rows.length;
    },
  };
}
