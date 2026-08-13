/**
 * Rate resolution: the design's "Rate resolution" section, implemented as a
 * SERVICE for the first time — the rate CARD (`billing_rates`) shipped in
 * migration 0011 with no resolver, per `bd show loxep-nw0`.
 *
 * ## The ladder
 *
 * Resolved at the moment a time entry is saved, then stored on the entry,
 * never joined at read time (see `time.ts`):
 *
 * ```text
 * 0. an explicit amount chosen by the operator            'manual'
 * 1. billing_rates scope_kind = 'project_person'   (this project, this worker)
 * 2. billing_rates scope_kind = 'project'          (this project, anyone)
 * 3. billing_rates scope_kind = 'counterparty'     (this client, anyone)
 * 4. billing_rates scope_kind = 'person'           (this worker, anywhere)
 * 5. billing_rates scope_kind = 'activity'         (this activity code, anywhere)
 * 6. billing_rates scope_kind = 'installation'     (the shop rate)
 * 7. nothing matched                               'unresolved'
 * ```
 *
 * Within a level, the row whose `[effective_from, effective_to]` range
 * contains `worked_on` wins; where two rows at the same level both cover the
 * date, the later `effective_from` wins (a same-`effective_from` tie breaks on
 * `id` for a deterministic, testable result — the design does not specify a
 * rule for that narrower case and leaves the overlap "a reconciliation finding
 * rather than an error").
 *
 * `unresolved` is a real state and never becomes zero: a billable entry with
 * no rate is a visible backlog, not a defaulted-to-zero invoice line.
 *
 * `resolveRate` is called twice per time entry — once for `rate_kind = 'bill'`
 * and once for `rate_kind = 'cost'` — because the two resolve through the
 * identical ladder against separate rows (see the design's "Cost rates are
 * the same table with `rate_kind = 'cost'`").
 */
import type { LoxepDb } from "@loxep/db";
import type { RateSource } from "@loxep/db/schema";
import { dateLiteral, textLiteral, uuidLiteral } from "./sql.ts";


type Executor = Pick<LoxepDb, "execute">;

export interface RateResolutionInput {
  rateKind: "bill" | "cost";
  projectId: string | null;
  counterpartyId: string | null;
  workedByUserId: string | null;
  workedByCounterpartyId: string | null;
  activityCode: string | null;
  /** The business date the rate must be effective on (`worked_on`). */
  workedOn: string;
}

export interface RateResolutionResult {
  amount: string | null;
  currency: string | null;
  source: RateSource;
  billingRateId: string | null;
}

interface RungRow {
  id: string;
  amount: string;
  currency: string;
}

/** A resolution rung: the `RateSource`/`scope_kind` label and the extra `where` clause it needs, or `null` to skip it entirely. */
interface Rung {
  source: Exclude<RateSource, "manual" | "unresolved">;
  predicate: string | null;
}

/**
 * `subject_user_id = ...` or `subject_counterparty_id = ...` — the two are
 * mutually exclusive on `time_entries`. `subject_user_id` is `text` (a Better
 * Auth user id per ADR-0020, not a UUID); `subject_counterparty_id` is a real
 * `uuid` FK.
 */
function subjectPredicate(input: RateResolutionInput): string | null {
  if (input.workedByUserId !== null) {
    return `subject_user_id = ${textLiteral(input.workedByUserId)}`;
  }
  if (input.workedByCounterpartyId !== null) {
    return `subject_counterparty_id = ${uuidLiteral(input.workedByCounterpartyId)}`;
  }
  return null;
}

function buildRungs(input: RateResolutionInput): Rung[] {
  const subject = subjectPredicate(input);
  const project =
    input.projectId === null ? null : `project_id = ${uuidLiteral(input.projectId)}`;
  return [
    {
      source: "project_person",
      predicate: project === null || subject === null ? null : `${project} and ${subject}`,
    },
    { source: "project", predicate: project },
    {
      source: "counterparty",
      predicate:
        input.counterpartyId === null
          ? null
          : `counterparty_id = ${uuidLiteral(input.counterpartyId)}`,
    },
    { source: "person", predicate: subject },
    {
      source: "activity",
      predicate:
        input.activityCode === null
          ? null
          : `activity_code = ${textLiteral(input.activityCode)}`,
    },
    { source: "installation", predicate: "true" },
  ];
}

export async function resolveRate(
  executor: Executor,
  input: RateResolutionInput,
): Promise<RateResolutionResult> {
  for (const rung of buildRungs(input)) {
    if (rung.predicate === null) continue;
    const result = await executor.execute(
      `select id, amount, currency from billing_rates
        where rate_kind = ${textLiteral(input.rateKind)}
          and scope_kind = ${textLiteral(rung.source)}
          and effective_from <= ${dateLiteral(input.workedOn)}
          and (effective_to is null or effective_to >= ${dateLiteral(input.workedOn)})
          and ${rung.predicate}
        order by effective_from desc, id desc
        limit 1`,
    );
    const row = result.rows[0] as RungRow | undefined;
    if (row !== undefined) {
      return {
        amount: row.amount,
        currency: row.currency,
        source: rung.source,
        billingRateId: row.id,
      };
    }
  }

  return { amount: null, currency: null, source: "unresolved", billingRateId: null };
}
