/**
 * Opportunity rules and scoring (loxep-7dp.5, roadmap Phase 2 "Opportunity
 * rules and scoring"): a small DECLARATIVE condition grammar over derived
 * `market_events` + the two observations they were derived from, a PURE
 * evaluator, and the `market_events.rule_id` stamping loop that finally uses
 * that previously dangling column.
 *
 * This is deliberately NOT a generic workflow/rule engine (a Phase 0
 * non-goal): conditions are a fixed, closed set of predicates validated by
 * {@link opportunityConditionsSchema}. There is no user-supplied expression
 * language, no arbitrary AND/OR nesting, and no side effects.
 *
 * ## Condition grammar
 *
 * `opportunity_rules.conditions` is a JSON object with up to five optional
 * groups; **at least one group must be present and every present group must
 * declare at least one predicate** (a rule that matches everything and scores
 * nothing is a footgun, not a feature). All declared predicates are ANDed —
 * there is no OR beyond the set-membership forms.
 *
 * ```text
 * {
 *   eventTypes?: MarketEventType[]        // non-empty, unique
 *   price?: {
 *     maxPrice?:        decimal string    // current.price <= maxPrice
 *     minDropAmount?:   decimal string    // previous.price - current.price >= amount
 *     minDropPercent?:  number (0, 100]   // 100*(prev-curr)/prev >= percent
 *   }
 *   quantity?: {
 *     minAvailable?:    int >= 0          // current.quantityAvailable >= n
 *     maxAvailable?:    int >= 0          // current.quantityAvailable <= n
 *     minIncrease?:     int >= 1          // current - previous >= n
 *   }
 *   listing?: {
 *     stateIn?:         string[]          // current.listingState in set
 *     stateNotIn?:      string[]          // current.listingState not in set
 *     availabilityIn?:  string[]          // current.availability in set
 *     transitionedTo?:  string            // previous.listingState != s and current == s
 *   }
 *   scope?: {
 *     monitorTargetIds?:   uuid[]         // event.monitorTargetId in set
 *     marketplaceItemIds?: uuid[]         // event.marketplaceItemId in set
 *   }
 * }
 * ```
 *
 * States are plain text (no PG enums, no closed TS union) everywhere except
 * `eventTypes`, which is closed to {@link MARKET_EVENT_TYPES} because event
 * derivation owns that vocabulary.
 *
 * **Unknown is never a match.** Following the `market_events` NULL rules, a
 * predicate whose input is missing (no previous observation, NULL price, NULL
 * quantity, absent `monitorTargetId`) FAILS rather than passing vacuously —
 * an unobserved metric can never produce an opportunity.
 *
 * Decimal comparisons are exact (BigInt over the decimal strings PostgreSQL
 * `numeric` produces); this module performs no JavaScript float arithmetic on
 * prices.
 *
 * ## Scoring formula
 *
 * ```text
 * score = score_weight * SUM(contribution(p) for each declared predicate p)
 * ```
 *
 * evaluated only when the rule matched (a non-match always scores `0`). Every
 * satisfied predicate contributes `1`, with one graded exception:
 *
 * ```text
 * contribution(price.minDropPercent) = 1 + min(actualDropPercent, 100) / 100
 * ```
 *
 * so a 40% drop contributes `1.4` and a 100% drop `2`, and two rules with the
 * same shape rank by how good the drop actually was. The sum, the weight, and
 * the product are computed as scaled integers and the result is rounded
 * half-up to 4 decimal places, so scoring is exact and replay-stable.
 *
 * ## Stamping semantics (`market_events.rule_id`)
 *
 * {@link evaluateRulesForEvent} loads enabled rules ordered by `priority ASC,
 * created_at ASC, id ASC` — **smaller `priority` is higher priority**, the
 * same convention as `monitor_targets` and Graphile Worker — evaluates all of
 * them, and stamps the event with the FIRST (highest-priority) match. One
 * event gets one attributing rule: `rule_id` answers "which rule made this an
 * opportunity", and a single deterministic winner keeps notification
 * rendering, dashboards, and replay unambiguous. Every match is still
 * returned to the caller, so nothing is lost.
 *
 * The stamp is a single `UPDATE ... WHERE id = $1 AND rule_id IS NULL`, so it
 * is idempotent and first-wins: an at-least-once replay (or a re-evaluation
 * after the rule set changed) never overwrites an earlier attribution and
 * never rewrites the recorded score. `payload` is MERGED, not clobbered —
 * only the namespaced {@link OPPORTUNITY_PAYLOAD_KEY} key is written.
 *
 * ## Notification seam
 *
 * Detection and delivery stay separate concepts (implementation contract):
 * nothing here enqueues deliveries. {@link evaluateRulesForEvent} returns the
 * scored matches and the caller decides whether to bridge them into
 * `enqueueDeliveriesForEvent` (@loxep/notifications). @loxep/market therefore
 * takes no dependency on @loxep/notifications, @loxep/jobs delivery types, or
 * @loxep/domain.
 */
import { opportunityRules } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { MarketNotFoundError, MarketValidationError } from "./errors.ts";
import { MARKET_EVENT_TYPES } from "./events.ts";
import type { ObservationSnapshot } from "./events.ts";
import {
  intLiteral,
  jsonbLiteral,
  textLiteral,
  uuidLiteral,
} from "./sql.ts";

/** Namespaced key written into `market_events.payload` (merge, not clobber). */
export const OPPORTUNITY_PAYLOAD_KEY = "opportunity";

/** Fixed decimal places for scores and weights (matches `numeric(10,4)`). */
export const SCORE_SCALE = 4;

const SCORE_UNIT = 10_000n; // 10 ** SCORE_SCALE

/** Internal working scale for price arithmetic (>= observations' numeric(20,6)). */
const PRICE_SCALE = 12;

const decimalStringPattern = /^-?\d+(\.\d+)?$/;

const decimalString = z
  .string()
  .regex(decimalStringPattern, "expected a decimal string");

/** `numeric(10,4)`-compatible non-negative weight, carried as a string. */
export const scoreWeightSchema = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,4})?$/, "expected a non-negative numeric(10,4) value");

const nonEmptyStrings = z.array(z.string().min(1)).min(1);

const priceConditionsSchema = z
  .strictObject({
    maxPrice: decimalString.optional(),
    minDropAmount: decimalString.optional(),
    minDropPercent: z.number().gt(0).lte(100).optional(),
  })
  .refine((group) => Object.keys(group).length > 0, {
    message: "price group declares no predicate",
  });

const quantityConditionsSchema = z
  .strictObject({
    minAvailable: z.number().int().nonnegative().optional(),
    maxAvailable: z.number().int().nonnegative().optional(),
    minIncrease: z.number().int().positive().optional(),
  })
  .refine((group) => Object.keys(group).length > 0, {
    message: "quantity group declares no predicate",
  });

const listingConditionsSchema = z
  .strictObject({
    stateIn: nonEmptyStrings.optional(),
    stateNotIn: nonEmptyStrings.optional(),
    availabilityIn: nonEmptyStrings.optional(),
    transitionedTo: z.string().min(1).optional(),
  })
  .refine((group) => Object.keys(group).length > 0, {
    message: "listing group declares no predicate",
  });

const scopeConditionsSchema = z
  .strictObject({
    monitorTargetIds: z.array(z.uuid()).min(1).optional(),
    marketplaceItemIds: z.array(z.uuid()).min(1).optional(),
  })
  .refine((group) => Object.keys(group).length > 0, {
    message: "scope group declares no predicate",
  });

/** The declarative condition grammar (see the module doc for semantics). */
export const opportunityConditionsSchema = z
  .strictObject({
    eventTypes: z.array(z.enum(MARKET_EVENT_TYPES)).min(1).optional(),
    price: priceConditionsSchema.optional(),
    quantity: quantityConditionsSchema.optional(),
    listing: listingConditionsSchema.optional(),
    scope: scopeConditionsSchema.optional(),
  })
  .refine((conditions) => Object.keys(conditions).length > 0, {
    message: "conditions must declare at least one group",
  })
  .refine(
    (conditions) =>
      conditions.eventTypes === undefined ||
      new Set(conditions.eventTypes).size === conditions.eventTypes.length,
    { message: "eventTypes must not repeat an event type" },
  );

export type OpportunityConditions = z.infer<typeof opportunityConditionsSchema>;
export type OpportunityConditionsInput = z.input<
  typeof opportunityConditionsSchema
>;

/** The rule facts evaluation needs (an `opportunity_rules` row fits). */
export interface OpportunityRuleDefinition {
  id: string;
  name: string;
  priority: number;
  conditions: unknown;
  /** `numeric(10,4)` as a decimal string. */
  scoreWeight: string;
}

/** The event facts evaluation needs (a `market_events` row fits). */
export interface OpportunityEventContext {
  eventType: string;
  marketplaceItemId: string;
  monitorTargetId?: string | null;
}

/** Everything a pure evaluation may look at. */
export interface OpportunityContext {
  event: OpportunityEventContext;
  currentObservation?: ObservationSnapshot | null;
  previousObservation?: ObservationSnapshot | null;
}

export interface OpportunityEvaluation {
  matched: boolean;
  /** `0` unless matched; otherwise the documented formula, 4 decimal places. */
  score: number;
  /**
   * Satisfied predicates when matched, failed predicates when not — always in
   * declaration order, always deterministic.
   */
  reasons: string[];
}

/** Exact decimal-string → scaled BigInt, or null when unparsable/absent. */
function toScaled(
  value: string | null | undefined,
  scale: number,
): bigint | null {
  if (typeof value !== "string") return null;
  const match = decimalStringPattern.exec(value);
  if (match === null) return null;
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [int = "0", frac = ""] = unsigned.split(".");
  if (frac.length > scale) {
    // More precision than the working scale: truncate deterministically.
    const magnitude = BigInt(int + frac.slice(0, scale));
    return negative ? -magnitude : magnitude;
  }
  const magnitude = BigInt(int + frac.padEnd(scale, "0"));
  return negative ? -magnitude : magnitude;
}

/** Render a scaled BigInt back to a decimal string (diagnostics/reasons). */
function fromScaled(value: bigint, scale: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const body = frac.length === 0 ? int : `${int}.${frac}`;
  return negative ? `-${body}` : body;
}

interface PredicateResult {
  label: string;
  satisfied: boolean;
  detail: string;
  /** Contribution scaled by {@link SCORE_UNIT}; only used when satisfied. */
  contribution: bigint;
}

const ONE = SCORE_UNIT;

function predicate(
  label: string,
  satisfied: boolean,
  detail: string,
  contribution: bigint = ONE,
): PredicateResult {
  return { label, satisfied, detail, contribution };
}

function inSet(value: string | null | undefined, set: readonly string[]): boolean {
  return typeof value === "string" && set.includes(value);
}

/**
 * Evaluate the declared predicates in a fixed order. Every predicate is
 * evaluated (no short-circuit), so `reasons` can report all failures.
 */
function evaluatePredicates(
  conditions: OpportunityConditions,
  context: OpportunityContext,
): PredicateResult[] {
  const results: PredicateResult[] = [];
  const { event } = context;
  const current = context.currentObservation ?? null;
  const previous = context.previousObservation ?? null;

  if (conditions.eventTypes !== undefined) {
    const set = conditions.eventTypes;
    results.push(
      predicate(
        "eventTypes",
        set.includes(event.eventType as (typeof set)[number]),
        `${event.eventType} vs [${set.join(", ")}]`,
      ),
    );
  }

  const price = conditions.price;
  if (price !== undefined) {
    const currentPrice = toScaled(current?.price, PRICE_SCALE);
    const previousPrice = toScaled(previous?.price, PRICE_SCALE);

    if (price.maxPrice !== undefined) {
      const threshold = toScaled(price.maxPrice, PRICE_SCALE);
      results.push(
        currentPrice === null || threshold === null
          ? predicate("price.maxPrice", false, "current price is unknown")
          : predicate(
              "price.maxPrice",
              currentPrice <= threshold,
              `${fromScaled(currentPrice, PRICE_SCALE)} <= ${price.maxPrice}`,
            ),
      );
    }

    if (price.minDropAmount !== undefined) {
      const threshold = toScaled(price.minDropAmount, PRICE_SCALE);
      results.push(
        currentPrice === null || previousPrice === null || threshold === null
          ? predicate(
              "price.minDropAmount",
              false,
              "both observations must carry a price",
            )
          : predicate(
              "price.minDropAmount",
              previousPrice - currentPrice >= threshold,
              `drop ${fromScaled(previousPrice - currentPrice, PRICE_SCALE)} >= ${price.minDropAmount}`,
            ),
      );
    }

    if (price.minDropPercent !== undefined) {
      const threshold = price.minDropPercent;
      if (currentPrice === null || previousPrice === null) {
        results.push(
          predicate(
            "price.minDropPercent",
            false,
            "both observations must carry a price",
          ),
        );
      } else if (previousPrice <= 0n) {
        // A percentage drop from a zero/negative base is undefined.
        results.push(
          predicate(
            "price.minDropPercent",
            false,
            "previous price is not positive",
          ),
        );
      } else {
        // Percent scaled by 1e6, truncating (sub-microdigit bias only).
        const percentScaled =
          ((previousPrice - currentPrice) * 100n * 1_000_000n) / previousPrice;
        const thresholdScaled = BigInt(Math.round(threshold * 1_000_000));
        const satisfied = percentScaled >= thresholdScaled;
        // Graded contribution: 1 + min(percent, 100)/100, at score scale.
        const cappedPercent =
          percentScaled > 100_000_000n ? 100_000_000n : percentScaled;
        const bonus = cappedPercent < 0n ? 0n : cappedPercent / 10_000n;
        results.push(
          predicate(
            "price.minDropPercent",
            satisfied,
            `${fromScaled(percentScaled, 6)}% >= ${threshold}%`,
            ONE + bonus,
          ),
        );
      }
    }
  }

  const quantity = conditions.quantity;
  if (quantity !== undefined) {
    const currentQty = current?.quantityAvailable ?? null;
    const previousQty = previous?.quantityAvailable ?? null;

    if (quantity.minAvailable !== undefined) {
      results.push(
        currentQty === null
          ? predicate(
              "quantity.minAvailable",
              false,
              "current quantity is unknown",
            )
          : predicate(
              "quantity.minAvailable",
              currentQty >= quantity.minAvailable,
              `${currentQty} >= ${quantity.minAvailable}`,
            ),
      );
    }
    if (quantity.maxAvailable !== undefined) {
      results.push(
        currentQty === null
          ? predicate(
              "quantity.maxAvailable",
              false,
              "current quantity is unknown",
            )
          : predicate(
              "quantity.maxAvailable",
              currentQty <= quantity.maxAvailable,
              `${currentQty} <= ${quantity.maxAvailable}`,
            ),
      );
    }
    if (quantity.minIncrease !== undefined) {
      results.push(
        currentQty === null || previousQty === null
          ? predicate(
              "quantity.minIncrease",
              false,
              "both observations must carry a quantity",
            )
          : predicate(
              "quantity.minIncrease",
              currentQty - previousQty >= quantity.minIncrease,
              `increase ${currentQty - previousQty} >= ${quantity.minIncrease}`,
            ),
      );
    }
  }

  const listing = conditions.listing;
  if (listing !== undefined) {
    const currentState = current?.listingState ?? null;
    const previousState = previous?.listingState ?? null;
    const currentAvailability = current?.availability ?? null;

    if (listing.stateIn !== undefined) {
      results.push(
        predicate(
          "listing.stateIn",
          inSet(currentState, listing.stateIn),
          `${currentState ?? "unknown"} vs [${listing.stateIn.join(", ")}]`,
        ),
      );
    }
    if (listing.stateNotIn !== undefined) {
      results.push(
        currentState === null
          ? predicate(
              "listing.stateNotIn",
              false,
              "current listing state is unknown",
            )
          : predicate(
              "listing.stateNotIn",
              !listing.stateNotIn.includes(currentState),
              `${currentState} not in [${listing.stateNotIn.join(", ")}]`,
            ),
      );
    }
    if (listing.availabilityIn !== undefined) {
      results.push(
        predicate(
          "listing.availabilityIn",
          inSet(currentAvailability, listing.availabilityIn),
          `${currentAvailability ?? "unknown"} vs [${listing.availabilityIn.join(", ")}]`,
        ),
      );
    }
    if (listing.transitionedTo !== undefined) {
      const target = listing.transitionedTo;
      results.push(
        currentState === null || previousState === null
          ? predicate(
              "listing.transitionedTo",
              false,
              "both observations must carry a listing state",
            )
          : predicate(
              "listing.transitionedTo",
              previousState !== target && currentState === target,
              `${previousState} -> ${currentState} (target ${target})`,
            ),
      );
    }
  }

  const scope = conditions.scope;
  if (scope !== undefined) {
    if (scope.monitorTargetIds !== undefined) {
      const value = event.monitorTargetId ?? null;
      results.push(
        predicate(
          "scope.monitorTargetIds",
          inSet(value, scope.monitorTargetIds),
          `${value ?? "unattributed"} vs ${scope.monitorTargetIds.length} id(s)`,
        ),
      );
    }
    if (scope.marketplaceItemIds !== undefined) {
      results.push(
        predicate(
          "scope.marketplaceItemIds",
          inSet(event.marketplaceItemId, scope.marketplaceItemIds),
          `${event.marketplaceItemId} vs ${scope.marketplaceItemIds.length} id(s)`,
        ),
      );
    }
  }

  return results;
}

/** Round a scaled-by-1e8 product back to {@link SCORE_SCALE}, half-up. */
function roundToScoreScale(productScaled: bigint): bigint {
  return (productScaled + SCORE_UNIT / 2n) / SCORE_UNIT;
}

/**
 * PURE rule evaluation — no I/O, no clock, no randomness. Same rule + same
 * context always produces the same verdict, score, and reasons.
 *
 * A rule whose stored `conditions`/`score_weight` do not satisfy the grammar
 * never throws and never matches: a hand-edited row degrades to "no
 * opportunity" instead of breaking a poll (the same leniency the adaptive
 * policy applies to `config.adaptive`). Only the CRUD service enforces shape
 * on the way in.
 */
export function evaluateRule(
  rule: OpportunityRuleDefinition,
  context: OpportunityContext,
): OpportunityEvaluation {
  const parsed = opportunityConditionsSchema.safeParse(rule.conditions);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    return { matched: false, score: 0, reasons: [`invalid conditions: ${issues}`] };
  }
  const weight = scoreWeightSchema.safeParse(rule.scoreWeight);
  if (!weight.success) {
    return {
      matched: false,
      score: 0,
      reasons: [`invalid score_weight: "${rule.scoreWeight}"`],
    };
  }

  const results = evaluatePredicates(parsed.data, context);
  const failed = results.filter((result) => !result.satisfied);
  if (failed.length > 0) {
    return {
      matched: false,
      score: 0,
      reasons: failed.map((result) => `${result.label}: ${result.detail}`),
    };
  }

  const contributions = results.reduce(
    (total, result) => total + result.contribution,
    0n,
  );
  const weightScaled = toScaled(weight.data, SCORE_SCALE) ?? 0n;
  const score = roundToScoreScale(weightScaled * contributions);
  return {
    matched: true,
    score: Number(fromScaled(score, SCORE_SCALE)),
    reasons: results.map((result) => `${result.label}: ${result.detail}`),
  };
}

/** One rule that matched an event, with its score and explanation. */
export interface OpportunityMatch {
  ruleId: string;
  ruleName: string;
  priority: number;
  score: number;
  reasons: string[];
}

/** The market-event fields the evaluation loop reads (a row fits). */
export interface EvaluableMarketEvent {
  id: string;
  marketplaceItemId: string;
  monitorTargetId: string | null;
  eventType: string;
  fromObservedAt: Date | null;
  toObservedAt: Date;
}

export interface EvaluateRulesForEventOptions {
  /** Supply observations directly to skip the hypertable lookup. */
  currentObservation?: ObservationSnapshot | null;
  previousObservation?: ObservationSnapshot | null;
  /** Recorded in the stamped payload; defaults to now. */
  evaluatedAt?: Date;
}

export interface EvaluateRulesForEventResult {
  /** Every matching rule, in evaluation (priority) order. */
  matches: OpportunityMatch[];
  /** The rule attributed to the event, whoever stamped it (or null). */
  ruleId: string | null;
  /** Whether THIS call wrote the stamp (false on a replay or no match). */
  stamped: boolean;
  /** How many enabled rules were evaluated. */
  evaluatedRuleCount: number;
}

export type OpportunityRuleRow = typeof opportunityRules.$inferSelect;

/** Enabled rules in evaluation order (`priority ASC, created_at ASC, id ASC`). */
export async function listEnabledRulesForEvaluation(
  db: LoxepDb,
): Promise<OpportunityRuleRow[]> {
  return db.query.opportunityRules.findMany({
    where: (table, { eq }) => eq(table.enabled, true),
    orderBy: (table, { asc }) => [
      asc(table.priority),
      asc(table.createdAt),
      asc(table.id),
    ],
  });
}

function snapshotFromObservationRow(row: {
  observedAt: Date;
  price: string | null;
  currency: string | null;
  quantityAvailable: number | null;
  availability: string | null;
  listingState: string | null;
}): ObservationSnapshot {
  return {
    observedAt: row.observedAt,
    price: row.price,
    currency: row.currency,
    quantityAvailable: row.quantityAvailable,
    availability: row.availability,
    listingState: row.listingState,
  };
}

/**
 * Load the two observations an event was derived from, by their exact
 * `observed_at` instants (the same facts the deduplication key is built
 * from). When several batches observed the item at the same instant the
 * newest-written row wins, deterministically.
 */
async function loadObservationsForEvent(
  db: LoxepDb,
  event: EvaluableMarketEvent,
): Promise<{
  current: ObservationSnapshot | null;
  previous: ObservationSnapshot | null;
}> {
  const instants = [event.toObservedAt];
  if (event.fromObservedAt !== null) instants.push(event.fromObservedAt);
  const rows = await db.query.marketplaceItemObservations.findMany({
    where: (table, { and, eq, inArray }) =>
      and(
        eq(table.marketplaceItemId, event.marketplaceItemId),
        inArray(table.observedAt, instants),
      ),
    orderBy: (table, { asc }) => [
      asc(table.observedAt),
      asc(table.observationBatchId),
    ],
  });
  let current: ObservationSnapshot | null = null;
  let previous: ObservationSnapshot | null = null;
  for (const row of rows) {
    const snapshot = snapshotFromObservationRow(row);
    if (row.observedAt.getTime() === event.toObservedAt.getTime()) {
      current = snapshot;
    } else if (
      event.fromObservedAt !== null &&
      row.observedAt.getTime() === event.fromObservedAt.getTime()
    ) {
      previous = snapshot;
    }
  }
  return { current, previous };
}

/**
 * Evaluate every enabled rule against one derived market event, stamp the
 * event with the first (highest-priority) match, and return the scored
 * matches for the CALLER to bridge into notification delivery. See the module
 * doc for the ordering, stamping, and seam rules.
 *
 * Observations are loaded from the hypertable unless the caller supplies
 * them; supplying them keeps the whole call pure apart from the stamp.
 */
export async function evaluateRulesForEvent(
  db: LoxepDb,
  event: EvaluableMarketEvent,
  options: EvaluateRulesForEventOptions = {},
): Promise<EvaluateRulesForEventResult> {
  const rules = await listEnabledRulesForEvaluation(db);
  if (rules.length === 0) {
    return { matches: [], ruleId: null, stamped: false, evaluatedRuleCount: 0 };
  }

  let current = options.currentObservation;
  let previous = options.previousObservation;
  if (current === undefined || previous === undefined) {
    const loaded = await loadObservationsForEvent(db, event);
    current ??= loaded.current;
    previous ??= loaded.previous;
  }

  const context: OpportunityContext = {
    event: {
      eventType: event.eventType,
      marketplaceItemId: event.marketplaceItemId,
      monitorTargetId: event.monitorTargetId,
    },
    currentObservation: current,
    previousObservation: previous,
  };

  const matches: OpportunityMatch[] = [];
  for (const rule of rules) {
    const evaluation = evaluateRule(
      {
        id: rule.id,
        name: rule.name,
        priority: rule.priority,
        conditions: rule.conditions,
        scoreWeight: rule.scoreWeight,
      },
      context,
    );
    if (evaluation.matched) {
      matches.push({
        ruleId: rule.id,
        ruleName: rule.name,
        priority: rule.priority,
        score: evaluation.score,
        reasons: evaluation.reasons,
      });
    }
  }

  if (matches.length === 0) {
    return {
      matches,
      ruleId: null,
      stamped: false,
      evaluatedRuleCount: rules.length,
    };
  }

  const winner = matches[0] as OpportunityMatch;
  const stamp = await stampEventWithRule(db, event.id, winner, {
    evaluatedAt: options.evaluatedAt ?? new Date(),
    matchCount: matches.length,
  });
  return {
    matches,
    ruleId: stamp.ruleId,
    stamped: stamp.stamped,
    evaluatedRuleCount: rules.length,
  };
}

/**
 * First-wins attribution stamp. `WHERE rule_id IS NULL` makes the write
 * idempotent and replay-safe; `payload` is merged so the derivation payload
 * (prices, quantities) survives untouched next to the namespaced
 * {@link OPPORTUNITY_PAYLOAD_KEY} block.
 */
async function stampEventWithRule(
  db: LoxepDb,
  marketEventId: string,
  match: OpportunityMatch,
  meta: { evaluatedAt: Date; matchCount: number },
): Promise<{ ruleId: string | null; stamped: boolean }> {
  const block = jsonbLiteral({
    [OPPORTUNITY_PAYLOAD_KEY]: {
      ruleId: match.ruleId,
      ruleName: match.ruleName,
      priority: match.priority,
      score: match.score,
      reasons: match.reasons,
      matchCount: meta.matchCount,
      evaluatedAt: meta.evaluatedAt.toISOString(),
    },
  });
  const updated = await db.execute(
    `update market_events
        set rule_id = ${uuidLiteral(match.ruleId)},
            payload = case
                        when jsonb_typeof(payload) = 'object'
                          then payload || ${block}
                        else ${block}
                      end
      where id = ${uuidLiteral(marketEventId)}
        and rule_id is null
      returning rule_id`,
  );
  const row = updated.rows[0];
  if (row !== undefined) {
    return { ruleId: row["rule_id"] as string, stamped: true };
  }
  // Already stamped (replay, or another rule won an earlier evaluation):
  // report the existing attribution and change nothing.
  const existing = await db.query.marketEvents.findFirst({
    where: (table, { eq }) => eq(table.id, marketEventId),
  });
  if (existing === undefined) {
    throw new MarketNotFoundError(`unknown market event "${marketEventId}"`);
  }
  return { ruleId: existing.ruleId, stamped: false };
}

/** The audit-relevant projection of a rule (see {@link OpportunityRulesService}). */
export interface OpportunityRuleSnapshot {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  conditions: unknown;
  scoreWeight: string;
  createdByUserId: string | null;
}

export function opportunityRuleSnapshot(
  row: OpportunityRuleRow,
): OpportunityRuleSnapshot {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    conditions: row.conditions,
    scoreWeight: row.scoreWeight,
    createdByUserId: row.createdByUserId,
  };
}

const createRuleSchema = z.strictObject({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  conditions: opportunityConditionsSchema,
  scoreWeight: scoreWeightSchema.optional(),
  createdByUserId: z.string().min(1).nullish(),
});

const updateRuleSchema = z
  .strictObject({
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().optional(),
    conditions: opportunityConditionsSchema.optional(),
    scoreWeight: scoreWeightSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "empty update" });

export type CreateOpportunityRuleInput = z.input<typeof createRuleSchema>;
export type UpdateOpportunityRuleInput = z.input<typeof updateRuleSchema>;

export interface OpportunityRuleMutation {
  rule: OpportunityRuleRow;
  before: OpportunityRuleSnapshot | null;
  after: OpportunityRuleSnapshot;
}

/**
 * CRUD over `opportunity_rules`.
 *
 * **Auditing is the caller's job.** @loxep/market deliberately does not depend
 * on @loxep/domain (and therefore not on its audit service), so every mutating
 * method returns `before`/`after` {@link OpportunityRuleSnapshot}s alongside
 * the row: the web/server layer writes the `audit_events` record from those
 * snapshots, exactly as it does for the other market services. `before` is
 * null on create; `deleteRule` returns `after: null`.
 */
export interface OpportunityRulesService {
  createRule: (
    input: CreateOpportunityRuleInput,
  ) => Promise<OpportunityRuleMutation>;
  getRule: (ruleId: string) => Promise<OpportunityRuleRow>;
  listRules: (filter?: { enabled?: boolean }) => Promise<OpportunityRuleRow[]>;
  updateRule: (
    ruleId: string,
    patch: UpdateOpportunityRuleInput,
  ) => Promise<OpportunityRuleMutation & { before: OpportunityRuleSnapshot }>;
  deleteRule: (
    ruleId: string,
  ) => Promise<{ before: OpportunityRuleSnapshot; after: null }>;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

export function createOpportunityRulesService(options: {
  db: LoxepDb;
}): OpportunityRulesService {
  const { db } = options;

  async function getRule(ruleId: string): Promise<OpportunityRuleRow> {
    const row = await db.query.opportunityRules.findFirst({
      where: (table, { eq }) => eq(table.id, ruleId),
    });
    if (row === undefined) {
      throw new MarketNotFoundError(`unknown opportunity rule "${ruleId}"`);
    }
    return row;
  }

  async function createRule(
    input: CreateOpportunityRuleInput,
  ): Promise<OpportunityRuleMutation> {
    const parsed = createRuleSchema.safeParse(input);
    if (!parsed.success) {
      throw new MarketValidationError(
        `invalid opportunity rule: ${formatIssues(parsed.error)}`,
      );
    }
    const values = parsed.data;
    const inserted = await db
      .insert(opportunityRules)
      .values({
        name: values.name,
        enabled: values.enabled ?? true,
        priority: values.priority ?? 0,
        conditions: values.conditions,
        scoreWeight: values.scoreWeight ?? "1.0000",
        createdByUserId: values.createdByUserId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new MarketNotFoundError("opportunity rule insert returned no row");
    }
    return { rule: row, before: null, after: opportunityRuleSnapshot(row) };
  }

  async function listRules(filter?: {
    enabled?: boolean;
  }): Promise<OpportunityRuleRow[]> {
    return db.query.opportunityRules.findMany({
      where: (table, { eq }) =>
        filter?.enabled === undefined
          ? undefined
          : eq(table.enabled, filter.enabled),
      orderBy: (table, { asc }) => [
        asc(table.priority),
        asc(table.createdAt),
        asc(table.id),
      ],
    });
  }

  async function updateRule(
    ruleId: string,
    patch: UpdateOpportunityRuleInput,
  ): Promise<OpportunityRuleMutation & { before: OpportunityRuleSnapshot }> {
    const parsed = updateRuleSchema.safeParse(patch);
    if (!parsed.success) {
      throw new MarketValidationError(
        `invalid opportunity rule patch: ${formatIssues(parsed.error)}`,
      );
    }
    const existing = await getRule(ruleId);
    const values = parsed.data;

    const assignments = ["updated_at = now()"];
    if (values.name !== undefined) {
      assignments.push(`name = ${textLiteral(values.name)}`);
    }
    if (values.enabled !== undefined) {
      assignments.push(`enabled = ${values.enabled ? "true" : "false"}`);
    }
    if (values.priority !== undefined) {
      // priority may be negative; intLiteral rejects negatives by contract.
      assignments.push(
        `priority = ${values.priority < 0 ? `-${intLiteral(-values.priority)}` : intLiteral(values.priority)}`,
      );
    }
    if (values.conditions !== undefined) {
      assignments.push(`conditions = ${jsonbLiteral(values.conditions)}`);
    }
    if (values.scoreWeight !== undefined) {
      assignments.push(
        `score_weight = ${textLiteral(values.scoreWeight)}::numeric`,
      );
    }
    await db.execute(
      `update opportunity_rules
          set ${assignments.join(", ")}
        where id = ${uuidLiteral(ruleId)}`,
    );
    const updated = await getRule(ruleId);
    return {
      rule: updated,
      before: opportunityRuleSnapshot(existing),
      after: opportunityRuleSnapshot(updated),
    };
  }

  async function deleteRule(
    ruleId: string,
  ): Promise<{ before: OpportunityRuleSnapshot; after: null }> {
    const existing = await getRule(ruleId);
    // `market_events.rule_id` is an attribution stamp, not a foreign key, so
    // deleting a rule never blocks and never rewrites recorded history: past
    // events keep pointing at the (now absent) rule id and their payload
    // block keeps the rule's name and score.
    await db.execute(
      `delete from opportunity_rules where id = ${uuidLiteral(ruleId)}`,
    );
    return { before: opportunityRuleSnapshot(existing), after: null };
  }

  return { createRule, getRule, listRules, updateRule, deleteRule };
}
