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
 */
import { monitorTargets } from "@loxep/db/schema";
import type { LoxepDb } from "@loxep/db";
import { z } from "zod";
import { MarketNotFoundError, MarketValidationError } from "./errors.ts";
import { intLiteral, timestamptzLiteral, uuidLiteral } from "./sql.ts";

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
 */
export const monitorTargetConfigSchemas = {
  /** The watchlist itself is identified by the target's connection. */
  ebay_watchlist: z.strictObject({}),
  /** A single public listing identified by its external item id. */
  ebay_item: z.strictObject({
    externalItemId: z.string().min(1),
    marketplace: z.string().min(1).optional(),
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

/**
 * Record a successful poll: stamps `last_poll_at`/`last_success_at` and
 * clears `consecutive_errors`/`backoff_until`. Safe to re-run (idempotent
 * for a fixed `at`).
 */
export async function recordPollSuccess(
  db: LoxepDb,
  targetId: string,
  options: { at?: Date } = {},
): Promise<void> {
  const at = timestamptzLiteral(options.at ?? new Date());
  const result = await db.execute(
    `update monitor_targets
        set last_poll_at = ${at},
            last_success_at = ${at},
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
