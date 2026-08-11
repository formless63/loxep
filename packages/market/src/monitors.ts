/**
 * Monitor scheduling (loxep-ubx.1): CRUD over `monitor_targets` plus the
 * data-driven due-work claim/poll-outcome primitives (ADR-0003, foundation
 * schema "Monitoring").
 *
 * Scheduling state lives in the database — `interval_seconds`,
 * `next_poll_at`, `priority`, `backoff_until`, `consecutive_errors` — and a
 * small number of recurring dispatcher jobs (see `tasks.ts`) claim due
 * targets. There is never one cron entry per monitored item.
 *
 * ## Claim semantics
 *
 * {@link claimDueTargets} is a single statement:
 *
 * ```sql
 * UPDATE monitor_targets SET next_poll_at = now + interval, ...
 *  WHERE id IN (SELECT id ... WHERE due ORDER BY priority, next_poll_at
 *               LIMIT n FOR UPDATE SKIP LOCKED)
 * RETURNING ...
 * ```
 *
 * `FOR UPDATE SKIP LOCKED` makes concurrent dispatchers partition the due
 * set instead of double-claiming: rows locked by one dispatcher are skipped
 * (not waited on) by the other, and because the claiming UPDATE advances
 * `next_poll_at` before commit, a target can never be claimed twice for the
 * same tick. Smaller `priority` claims first, matching Graphile Worker's
 * priority convention.
 *
 * ## Backoff
 *
 * {@link recordPollFailure} applies capped exponential backoff:
 * `backoff_until = failed_at + min(interval_seconds * 2^consecutive_errors,
 * 3600) seconds`, where `consecutive_errors` is the post-increment count
 * (first failure → 2× interval) and the cap is one hour
 * ({@link MAX_BACKOFF_SECONDS}). {@link recordPollSuccess} resets
 * `consecutive_errors`/`backoff_until`. The dispatcher never claims a target
 * whose `backoff_until` is in the future.
 *
 * ## Adaptive cadence
 *
 * `interval_seconds` is the operator-set BASE cadence and never changes by
 * itself. When a caller reports poll CHANGE information,
 * {@link recordPollSuccess} advances `next_poll_at` by the activity-adaptive
 * interval from `computeAdaptiveInterval` instead of the flat base, and
 * merges the transient streak state into `config.adaptive` — no schema
 * change, no extra table (see `adaptive.ts` for the exact tiers). Callers
 * that report nothing keep the historical flat behaviour, as does a target
 * configured with `config.adaptive.enabled = false`.
 *
 * The claim statement is deliberately untouched: adaptivity is computed at
 * RECORD time, so claim atomicity and at-least-once safety are exactly what
 * they were. The claim's own flat advance remains the safety net that keeps
 * a target scheduled when a poll job dies before recording anything.
 */
import { monitorTargets } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import {
  ADAPTIVE_CONFIG_KEY,
  DEFAULT_ADAPTIVE_SIGNAL_WINDOW_SECONDS,
  adaptiveConfigSchema,
  adaptiveStatePatch,
  evaluateAdaptiveInterval,
  nextUnchangedStreak,
  readAdaptiveState,
} from "./adaptive.ts";
import type { AdaptiveBounds, AdaptiveDecision } from "./adaptive.ts";
import { MarketNotFoundError, MarketValidationError } from "./errors.ts";
import { LISTING_STATE_ENDED } from "./events.ts";
import {
  intLiteral,
  jsonbLiteral,
  textLiteral,
  timestamptzLiteral,
  uuidLiteral,
} from "./sql.ts";

/** Initial monitor target types (foundation schema); text + TS union, no PG enum. */
export const MONITOR_TARGET_TYPES = ["ebay_watchlist", "ebay_item"] as const;
export type MonitorTargetType = (typeof MONITOR_TARGET_TYPES)[number];

/** Exponential-backoff cap: one hour. */
export const MAX_BACKOFF_SECONDS = 3600;

/**
 * Pure backoff formula (exported for tests/documentation):
 * `min(intervalSeconds * 2^consecutiveErrors, 3600)` seconds, where
 * `consecutiveErrors` is the count AFTER the failing poll was recorded.
 * The exponent is clamped so the intermediate product cannot overflow.
 */
export function backoffSeconds(
  intervalSeconds: number,
  consecutiveErrors: number,
): number {
  const exponent = Math.min(Math.max(consecutiveErrors, 0), 20);
  return Math.min(intervalSeconds * 2 ** exponent, MAX_BACKOFF_SECONDS);
}

/**
 * Per-target-type `config` validation (Phase 0 shapes; provider adapters
 * arrive in Phase 1 and may extend these without changing the scheduling
 * model).
 *
 * Every target type also accepts the namespaced `adaptive` key
 * (`adaptiveConfigSchema`): the scheduler's transient adaptivity state and
 * its `enabled` opt-out live there, so activity-adaptive cadence needs no
 * schema change and no new table.
 */
export const monitorTargetConfigSchemas = {
  /** The watchlist itself is identified by the target's connection. */
  ebay_watchlist: z.strictObject({
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
  /** A single public listing identified by its external item id. */
  ebay_item: z.strictObject({
    externalItemId: z.string().min(1),
    marketplace: z.string().min(1).optional(),
    [ADAPTIVE_CONFIG_KEY]: adaptiveConfigSchema.optional(),
  }),
} as const satisfies Record<MonitorTargetType, z.ZodType>;

export type MonitorTargetRow = typeof monitorTargets.$inferSelect;

const baseTargetFields = {
  targetType: z.enum(MONITOR_TARGET_TYPES),
  name: z.string().min(1),
  connectionId: z.uuid().nullish(),
  enabled: z.boolean().optional(),
  intervalSeconds: z.number().int().positive(),
  priority: z.number().int().optional(),
  config: z.unknown().optional(),
  nextPollAt: z.date().optional(),
  createdByUserId: z.string().min(1).nullish(),
};

const createTargetSchema = z.strictObject(baseTargetFields);

const updateTargetSchema = z
  .strictObject({
    targetType: baseTargetFields.targetType.optional(),
    name: baseTargetFields.name.optional(),
    connectionId: baseTargetFields.connectionId,
    enabled: z.boolean().optional(),
    intervalSeconds: baseTargetFields.intervalSeconds.optional(),
    priority: z.number().int().optional(),
    config: z.unknown().optional(),
    nextPollAt: z.date().nullish(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "empty update",
  });

export type CreateMonitorTargetInput = z.input<typeof createTargetSchema>;
export type UpdateMonitorTargetInput = z.input<typeof updateTargetSchema>;

function validateConfig(
  targetType: MonitorTargetType,
  config: unknown,
): Record<string, unknown> {
  const schema = monitorTargetConfigSchemas[targetType];
  const result = schema.safeParse(config ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
    throw new MarketValidationError(
      `invalid "${targetType}" monitor config: ${issues}`,
    );
  }
  return result.data as Record<string, unknown>;
}

export interface MonitorService {
  createTarget: (input: CreateMonitorTargetInput) => Promise<MonitorTargetRow>;
  getTarget: (targetId: string) => Promise<MonitorTargetRow>;
  listTargets: (filter?: {
    enabled?: boolean;
    targetType?: MonitorTargetType;
  }) => Promise<MonitorTargetRow[]>;
  updateTarget: (
    targetId: string,
    patch: UpdateMonitorTargetInput,
  ) => Promise<MonitorTargetRow>;
  deleteTarget: (targetId: string) => Promise<void>;
}

/** CRUD service over `monitor_targets`. */
/**
 * `db.execute(<string>)` bypasses Drizzle's column mappers, so timestamptz
 * values come back as raw strings; coerce robustly.
 */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

export function createMonitorService(options: { db: LoxepDb }): MonitorService {
  const { db } = options;

  async function getTarget(targetId: string): Promise<MonitorTargetRow> {
    const row = await db.query.monitorTargets.findFirst({
      where: (table, { eq }) => eq(table.id, targetId),
    });
    if (row === undefined) {
      throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
    }
    return row;
  }

  async function createTarget(
    input: CreateMonitorTargetInput,
  ): Promise<MonitorTargetRow> {
    const parsed = createTargetSchema.parse(input);
    const config = validateConfig(parsed.targetType, parsed.config);
    const inserted = await db
      .insert(monitorTargets)
      .values({
        targetType: parsed.targetType,
        name: parsed.name,
        connectionId: parsed.connectionId ?? null,
        enabled: parsed.enabled ?? true,
        intervalSeconds: parsed.intervalSeconds,
        priority: parsed.priority ?? 0,
        // A new monitor is immediately due unless the caller schedules it.
        nextPollAt: parsed.nextPollAt ?? new Date(),
        config,
        createdByUserId: parsed.createdByUserId ?? null,
      })
      .returning();
    const row = inserted[0];
    if (row === undefined) {
      throw new MarketNotFoundError("monitor target insert returned no row");
    }
    return row;
  }

  async function listTargets(filter?: {
    enabled?: boolean;
    targetType?: MonitorTargetType;
  }): Promise<MonitorTargetRow[]> {
    return db.query.monitorTargets.findMany({
      where: (table, { and, eq }) => {
        const conditions = [];
        if (filter?.enabled !== undefined) {
          conditions.push(eq(table.enabled, filter.enabled));
        }
        if (filter?.targetType !== undefined) {
          conditions.push(eq(table.targetType, filter.targetType));
        }
        return conditions.length > 0 ? and(...conditions) : undefined;
      },
      orderBy: (table, { asc }) => [asc(table.createdAt), asc(table.id)],
    });
  }

  async function updateTarget(
    targetId: string,
    patch: UpdateMonitorTargetInput,
  ): Promise<MonitorTargetRow> {
    const parsed = updateTargetSchema.parse(patch);
    const existing = await getTarget(targetId);

    const targetType = (parsed.targetType ??
      existing.targetType) as MonitorTargetType;
    if (!MONITOR_TARGET_TYPES.includes(targetType)) {
      throw new MarketValidationError(
        `existing target has unknown type "${targetType}"`,
      );
    }
    // Re-validate config whenever the type or the config changes.
    const config =
      parsed.config !== undefined || parsed.targetType !== undefined
        ? validateConfig(targetType, parsed.config ?? existing.config)
        : undefined;

    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.targetType !== undefined) set["targetType"] = parsed.targetType;
    if (parsed.name !== undefined) set["name"] = parsed.name;
    if (parsed.connectionId !== undefined) {
      set["connectionId"] = parsed.connectionId;
    }
    if (parsed.enabled !== undefined) set["enabled"] = parsed.enabled;
    if (parsed.intervalSeconds !== undefined) {
      set["intervalSeconds"] = parsed.intervalSeconds;
    }
    if (parsed.priority !== undefined) set["priority"] = parsed.priority;
    if (config !== undefined) set["config"] = config;
    if (parsed.nextPollAt !== undefined) set["nextPollAt"] = parsed.nextPollAt;

    // Primary-key upsert (row is known to exist) — the package's standing
    // pattern for UPDATE without a direct drizzle-orm dependency.
    await db
      .insert(monitorTargets)
      .values({
        id: existing.id,
        targetType: existing.targetType,
        name: existing.name,
        intervalSeconds: existing.intervalSeconds,
      })
      .onConflictDoUpdate({ target: monitorTargets.id, set });
    return getTarget(targetId);
  }

  async function deleteTarget(targetId: string): Promise<void> {
    // Referencing rows (monitor_items, market_events, notification_rules)
    // intentionally RESTRICT the delete; disable the target instead when
    // history must be preserved.
    await getTarget(targetId);
    await db.execute(
      `delete from monitor_targets where id = ${uuidLiteral(targetId)}`,
    );
  }

  return { createTarget, getTarget, listTargets, updateTarget, deleteTarget };
}

/** A row claimed by {@link claimDueTargets} for immediate polling. */
export interface ClaimedTarget {
  id: string;
  connectionId: string | null;
  targetType: string;
  name: string;
  intervalSeconds: number;
  priority: number;
  config: Record<string, unknown>;
  /** The already-advanced next poll time (claim time + interval). */
  nextPollAt: Date;
}

/**
 * Atomically claim up to `limit` due targets and advance their
 * `next_poll_at` by one interval, so concurrent dispatchers never
 * double-claim (see the module doc for the exact semantics). A target is due
 * when it is enabled, `next_poll_at <= now`, and `backoff_until` is null or
 * past.
 */
export async function claimDueTargets(
  db: LoxepDb,
  options: { now?: Date; limit?: number } = {},
): Promise<ClaimedTarget[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? 100;
  const nowLiteral = timestamptzLiteral(now);
  const result = await db.execute(
    `update monitor_targets
        set next_poll_at = ${nowLiteral} + interval_seconds * interval '1 second',
            updated_at = now()
      where id in (
        select id
          from monitor_targets
         where enabled = true
           and next_poll_at is not null
           and next_poll_at <= ${nowLiteral}
           and (backoff_until is null or backoff_until <= ${nowLiteral})
         order by priority asc, next_poll_at asc
         limit ${intLiteral(limit)}
         for update skip locked
      )
      returning id, connection_id, target_type, name, interval_seconds,
                priority, config, next_poll_at`,
  );
  const claimed = result.rows.map((row) => ({
    id: row["id"] as string,
    connectionId: (row["connection_id"] as string | null) ?? null,
    targetType: row["target_type"] as string,
    name: row["name"] as string,
    intervalSeconds: row["interval_seconds"] as number,
    priority: row["priority"] as number,
    config: (row["config"] as Record<string, unknown>) ?? {},
    nextPollAt: toDate(row["next_poll_at"]),
  }));
  // UPDATE ... RETURNING order is not guaranteed to follow the claiming
  // subquery's ORDER BY; re-sort so dispatch order is deterministic.
  claimed.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.nextPollAt.getTime() - b.nextPollAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  return claimed;
}

/** Activity signals derived from stored history for one monitor target. */
export interface AdaptiveSignals {
  /** `market_events` for the target's items inside the window. */
  recentEventCount: number;
  /** Observation `raw_state_hash` deltas inside the window. */
  recentChangeCount: number;
  /** Seconds to the soonest future `listing_ends_at`, or null. */
  secondsUntilListingEnd: number | null;
  /** The window actually used, in seconds. */
  windowSeconds: number;
}

/**
 * Derive the adaptive policy's activity inputs from tables that already
 * exist — `market_events`, `marketplace_item_observations` (hash deltas), and
 * `marketplace_items.listing_ends_at` — for the items linked to a target.
 * One statement, read-only; the policy itself stays pure.
 *
 * An event counts when it is attributed to this target OR concerns one of
 * its actively linked items. Auction proximity only considers items that are
 * still linked, not `ended`, and whose end is in the future.
 */
export async function collectAdaptiveSignals(
  db: LoxepDb,
  monitorTargetId: string,
  options: { now?: Date; windowSeconds?: number } = {},
): Promise<AdaptiveSignals> {
  const now = options.now ?? new Date();
  const windowSeconds =
    options.windowSeconds ?? DEFAULT_ADAPTIVE_SIGNAL_WINDOW_SECONDS;
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new MarketValidationError(
      "windowSeconds must be a positive integer number of seconds",
    );
  }
  const targetLiteral = uuidLiteral(monitorTargetId);
  const nowLiteral = timestamptzLiteral(now);
  const sinceLiteral = timestamptzLiteral(
    new Date(now.getTime() - windowSeconds * 1000),
  );
  const result = await db.execute(
    `with linked as (
        select marketplace_item_id
          from monitor_items
         where monitor_target_id = ${targetLiteral}
           and active = true
      ),
      event_counts as (
        select count(*)::int as n
          from market_events e
         where (
                 e.monitor_target_id = ${targetLiteral}
                 or e.marketplace_item_id in (select marketplace_item_id from linked)
               )
           and e.detected_at > ${sinceLiteral}
           and e.detected_at <= ${nowLiteral}
      ),
      hashes as (
        select o.raw_state_hash,
               lag(o.raw_state_hash) over (
                 partition by o.marketplace_item_id order by o.observed_at
               ) as previous_hash
          from marketplace_item_observations o
         where o.marketplace_item_id in (select marketplace_item_id from linked)
           and o.observed_at > ${sinceLiteral}
           and o.observed_at <= ${nowLiteral}
      ),
      change_counts as (
        select count(*)::int as n
          from hashes
         where raw_state_hash is not null
           and previous_hash is not null
           and raw_state_hash <> previous_hash
      ),
      ends as (
        select min(
                 extract(epoch from (i.listing_ends_at - ${nowLiteral}))
               )::double precision as seconds
          from marketplace_items i
         where i.id in (select marketplace_item_id from linked)
           and i.listing_ends_at is not null
           and i.listing_ends_at >= ${nowLiteral}
           and i.current_state <> ${textLiteral(LISTING_STATE_ENDED)}
      )
      select event_counts.n as event_count,
             change_counts.n as change_count,
             ends.seconds as seconds_until_end
        from event_counts, change_counts, ends`,
  );
  const row = result.rows[0];
  const secondsRaw = row?.["seconds_until_end"];
  return {
    recentEventCount: Number(row?.["event_count"] ?? 0),
    recentChangeCount: Number(row?.["change_count"] ?? 0),
    secondsUntilListingEnd:
      secondsRaw === null || secondsRaw === undefined
        ? null
        : Number(secondsRaw),
    windowSeconds,
  };
}

/**
 * Poll-outcome facts a caller may report to {@link recordPollSuccess}.
 * Supplying `changed` is what opts a call into adaptive advancement.
 */
export interface RecordPollSuccessOptions {
  at?: Date;
  /**
   * Whether this poll observed any change (a `raw_state_hash` delta, a new
   * item, a derived event). Omitted → the historical flat behaviour.
   */
  changed?: boolean;
  /** Seconds to the soonest future `listing_ends_at` for this target. */
  secondsUntilListingEnd?: number | null;
  /** `market_events` count in the recent window (default 0). */
  recentEventCount?: number;
  /** Observation-change count in the recent window (default: 1 if changed). */
  recentChangeCount?: number;
  /**
   * Hard interval bounds. `bounds.minSeconds` is where the caller injects its
   * per-connection RATE BUDGET floor — the eBay executor passes the floor its
   * limiter allows for the connection.
   */
  bounds?: Partial<AdaptiveBounds>;
  /**
   * Derive omitted signals from stored history via
   * {@link collectAdaptiveSignals} (one extra read). Default false: the poll
   * path performs no query a caller did not ask for.
   */
  deriveSignals?: boolean;
  /** Window for derived signals (default one hour). */
  signalWindowSeconds?: number;
}

/** What {@link recordPollSuccess} did with the schedule. */
export interface PollSuccessResult {
  /** The adaptive decision, or null when the flat path ran. */
  adaptive: (AdaptiveDecision & { unchangedStreak: number }) | null;
  /** The stored `next_poll_at` after the adaptive advance, else null. */
  nextPollAt: Date | null;
}

/**
 * Record a successful poll: stamps `last_poll_at`/`last_success_at` and
 * clears `consecutive_errors`/`backoff_until`. Safe to re-run (idempotent
 * for a fixed `at`).
 *
 * When `options.changed` is supplied and the target has not opted out
 * (`config.adaptive.enabled === false`), this also advances `next_poll_at` by
 * the adaptive interval and merges the new streak state into
 * `config.adaptive`. Replaying the same `at` recomputes the identical
 * interval and does not inflate the streak.
 */
export async function recordPollSuccess(
  db: LoxepDb,
  targetId: string,
  options: RecordPollSuccessOptions = {},
): Promise<PollSuccessResult> {
  const at = options.at ?? new Date();
  if (options.changed === undefined) {
    await recordFlatPollSuccess(db, targetId, at);
    return { adaptive: null, nextPollAt: null };
  }

  const target = await db.query.monitorTargets.findFirst({
    where: (table, { eq }) => eq(table.id, targetId),
  });
  if (target === undefined) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
  const state = readAdaptiveState(target.config);
  if (!state.enabled) {
    await recordFlatPollSuccess(db, targetId, at);
    return { adaptive: null, nextPollAt: null };
  }

  const changed = options.changed;
  let recentEventCount = options.recentEventCount;
  let recentChangeCount = options.recentChangeCount;
  let secondsUntilListingEnd = options.secondsUntilListingEnd;
  if (
    options.deriveSignals === true &&
    (recentEventCount === undefined ||
      recentChangeCount === undefined ||
      secondsUntilListingEnd === undefined)
  ) {
    const signals = await collectAdaptiveSignals(db, targetId, {
      now: at,
      ...(options.signalWindowSeconds === undefined
        ? {}
        : { windowSeconds: options.signalWindowSeconds }),
    });
    recentEventCount ??= signals.recentEventCount;
    recentChangeCount ??= signals.recentChangeCount;
    secondsUntilListingEnd ??= signals.secondsUntilListingEnd;
  }

  const unchangedStreak = nextUnchangedStreak({ state, changed, at });
  const decision = evaluateAdaptiveInterval({
    baseIntervalSeconds: target.intervalSeconds,
    recentEventCount: recentEventCount ?? 0,
    // A changed poll is itself one observed change when nothing else is known.
    recentChangeCount: recentChangeCount ?? (changed ? 1 : 0),
    unchangedStreak,
    secondsUntilListingEnd: secondsUntilListingEnd ?? null,
    previousIntervalSeconds: state.lastComputedInterval,
    ...(options.bounds === undefined ? {} : { bounds: options.bounds }),
  });

  const atLiteral = timestamptzLiteral(at);
  const patch = jsonbLiteral({
    [ADAPTIVE_CONFIG_KEY]: adaptiveStatePatch({ unchangedStreak, decision, at }),
  });
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${atLiteral},
            last_success_at = ${atLiteral},
            consecutive_errors = 0,
            backoff_until = null,
            next_poll_at = ${atLiteral}
              + ${intLiteral(decision.intervalSeconds)} * interval '1 second',
            config = case
                       when jsonb_typeof(config) = 'object'
                         then case
                                when jsonb_typeof(config -> '${ADAPTIVE_CONFIG_KEY}') = 'object'
                                  then jsonb_set(
                                         config,
                                         '{${ADAPTIVE_CONFIG_KEY}}',
                                         (config -> '${ADAPTIVE_CONFIG_KEY}') || (${patch} -> '${ADAPTIVE_CONFIG_KEY}')
                                       )
                                else config || ${patch}
                              end
                       else ${patch}
                     end,
            updated_at = now()
      where id = ${uuidLiteral(targetId)}
      returning next_poll_at`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
  return {
    adaptive: { ...decision, unchangedStreak },
    nextPollAt: toDate(row["next_poll_at"]),
  };
}

/** The historical flat success bookkeeping (never touches `next_poll_at`). */
async function recordFlatPollSuccess(
  db: LoxepDb,
  targetId: string,
  at: Date,
): Promise<void> {
  const atLiteral = timestamptzLiteral(at);
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${atLiteral},
            last_success_at = ${atLiteral},
            consecutive_errors = 0,
            backoff_until = null,
            updated_at = now()
      where id = ${uuidLiteral(targetId)}
      returning id`,
  );
  if (result.rows.length === 0) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
}

/**
 * Record a failed poll: stamps `last_poll_at`, increments
 * `consecutive_errors`, and sets `backoff_until` per the capped exponential
 * formula in the module doc (mirrored by {@link backoffSeconds}).
 */
export async function recordPollFailure(
  db: LoxepDb,
  targetId: string,
  options: { at?: Date } = {},
): Promise<{ consecutiveErrors: number; backoffUntil: Date }> {
  const at = timestamptzLiteral(options.at ?? new Date());
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${at},
            consecutive_errors = consecutive_errors + 1,
            backoff_until = ${at}
              + least(
                  interval_seconds::numeric
                    * power(2::numeric, least(consecutive_errors + 1, 20)),
                  ${intLiteral(MAX_BACKOFF_SECONDS)}::numeric
                ) * interval '1 second',
            updated_at = now()
      where id = ${uuidLiteral(targetId)}
      returning consecutive_errors, backoff_until`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new MarketNotFoundError(`unknown monitor target "${targetId}"`);
  }
  return {
    consecutiveErrors: row["consecutive_errors"] as number,
    backoffUntil: toDate(row["backoff_until"]),
  };
}
