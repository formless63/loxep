/**
 * Order-payload retention sweep (ADR-0021, loxep-xh9.9).
 *
 * Foundational decision 7 retains `provider_objects` snapshots forever with
 * "no automatic retention/deletion policy by default". Commerce ingestion
 * broke the assumption behind that stance: an ORDER payload carries buyer
 * personal data that a marketplace observation payload never does — billing
 * and shipping addresses, email, phone, customer IP and user agent on
 * WooCommerce, plus a taxpayer id and gift-recipient details on eBay.
 * ADR-0021 refines the rule for that object class alone:
 *
 * ```text
 * after N days   payload := the provider's redacted form of that payload
 *                redacted_at := now
 * never          delete the provider_objects row
 * never          touch order_source_links
 * never          recompute payload_hash
 * ```
 *
 * ## Redaction, not deletion — and why `payload_hash` is left alone
 *
 * `payload_hash` stays the hash of the ORIGINAL payload because it is the
 * dedup/identity key: `retainProvenance` decides "this re-sync is unchanged"
 * by comparing the incoming payload's hash to the newest stored row's. Were
 * the sweep to rehash the redacted payload, every re-sync of an old order
 * would look like a change and store a fresh, fully-populated copy of the
 * personal data the sweep had just removed — the exact opposite of the
 * policy. The consequence is intended and documented on the column: after a
 * sweep the stored payload no longer hashes to `payload_hash`, and
 * `provider_objects.redacted_at` is what makes that state explicit rather than
 * looking like corruption.
 *
 * ## The redactors are INJECTED
 *
 * `@loxep/commerce` must not reach into an integration package to find out
 * what a provider's redacted form looks like — the same boundary that makes
 * the eBay order pager an injected seam (see `ebay-sync.ts`). The composition
 * root (`@loxep/app`) supplies an `object_type` → {@link OrderPayloadRedactor}
 * map built from `redactWooOrderFact` / `redactEbayOrderFact`, and this module
 * only ever sees a plain function from one JSON object to another.
 *
 * That injection is also what bounds the sweep's SCOPE. Only object types with
 * an injected redactor are selected for rewriting, so an order class Loxep can
 * ingest but cannot yet redact is never dragged into a batch it would occupy
 * forever — it is COUNTED and reported instead
 * ({@link OrderPayloadRedactionSweepResult.unhandled}), which is the signal
 * that a provider shipped order ingestion without shipping the redaction
 * helper ADR-0021 requires alongside it.
 *
 * ## Idempotent and at-least-once safe
 *
 * Every rewrite carries `and redacted_at is null` in its `WHERE`, so a
 * redelivered job, two overlapping runs, or a retry after a partial batch
 * re-redacts nothing: the row is claimed by whichever statement gets there
 * first and the other updates zero rows. A second full run over an
 * already-swept window finds no eligible rows at all and reports zero.
 *
 * ## Bounded work per run
 *
 * The sweep is a maintenance job sharing a worker with polls and deliveries,
 * so it never opens an unbounded rewrite of the whole table. It reads
 * {@link DEFAULT_REDACTION_BATCH_SIZE} rows at a time, oldest first, for at
 * most {@link DEFAULT_REDACTION_MAX_BATCHES} batches, then reports whether
 * more remained ({@link OrderPayloadRedactionSweepResult.more}) and leaves the
 * rest to the next scheduled run. A backlog therefore drains over several
 * runs instead of in one long transaction-heavy burst.
 */
import type { LoxepDb } from "@loxep/db";
import {
  createSettingsService,
  orderPayloadRetentionSetting,
} from "@loxep/domain";
import type { SettingsService } from "@loxep/domain";
import type { JobsLogger } from "@loxep/jobs";
import { EBAY_ORDER_OBJECT_TYPE } from "./ebay.ts";
import { CommerceValidationError } from "./errors.ts";
import { MEDUSA_ORDER_OBJECT_TYPE } from "./medusa.ts";
import {
  jsonbLiteral,
  textLiteral,
  timestamptzLiteral,
  uuidLiteral,
} from "./sql.ts";
import { WOO_ORDER_OBJECT_TYPE } from "./woo.ts";

/**
 * The `provider_objects.object_type` values this package's ingestion writes
 * for ORDER-class objects — the only classes ADR-0021 applies to.
 *
 * This list is what the sweep reports UNHANDLED counts against: a type here
 * with no injected redactor means Loxep is storing order payloads it has no
 * way to redact. It is not what the sweep selects for rewriting (that is the
 * injected redactor map), so adding a provider's ingestion before its
 * redaction helper degrades to a loud count, never to a stuck batch.
 */
export const ORDER_PROVIDER_OBJECT_TYPES = [
  WOO_ORDER_OBJECT_TYPE,
  EBAY_ORDER_OBJECT_TYPE,
  MEDUSA_ORDER_OBJECT_TYPE,
] as const;

/**
 * One provider's redaction of one stored order payload.
 *
 * Contract, all three parts load-bearing:
 *
 * 1. **Total on its own output.** Applying it to an already-redacted payload
 *    must return that payload unchanged. The `redacted_at is null` guard means
 *    this should never happen, but a redactor that would throw on its own
 *    output turns a hypothetical into an outage.
 * 2. **JSON-serializable object.** The result goes into a `jsonb NOT NULL`
 *    column; anything else is rejected before the write.
 * 3. **No personal data.** The whole point. A redactor that merely reshapes
 *    the payload has done nothing.
 *
 * Throwing is allowed and safe: the row is left un-redacted, counted in
 * {@link OrderPayloadRedactionSweepResult.failed}, and logged. It is not a
 * silent success, and it never destroys a payload the redactor could not
 * understand.
 */
export type OrderPayloadRedactor = (
  payload: Record<string, unknown>,
) => Record<string, unknown>;

/** `object_type` → the redactor for that class, supplied by the composition root. */
export type OrderPayloadRedactors = Readonly<
  Record<string, OrderPayloadRedactor>
>;

/** Rows read (and at most rewritten) per batch. */
export const DEFAULT_REDACTION_BATCH_SIZE = 200;
/** Batches one run may execute before deferring the rest to the next run. */
export const DEFAULT_REDACTION_MAX_BATCHES = 25;

export interface OrderPayloadRedactionSweepResult {
  /** The policy this run read. `keep` means nothing was examined. */
  mode: "redact" | "keep";
  /** The configured window, in days. */
  afterDays: number;
  /** Payloads stored strictly before this instant were eligible; null in `keep` mode. */
  cutoff: Date | null;
  /** Eligible rows read across all batches. */
  scanned: number;
  /** Rows whose payload was replaced and `redacted_at` stamped by THIS run. */
  redacted: number;
  /**
   * Rows already claimed by a concurrent or previous run between this run's
   * read and its write — the at-least-once guard firing, not an error.
   */
  alreadyRedacted: number;
  /** Rows whose redactor threw; left verbatim and reported. */
  failed: number;
  /**
   * Eligible rows of a known order class with NO injected redactor, by object
   * type. Non-empty means a provider ships order ingestion without the
   * redaction helper ADR-0021 requires.
   */
  unhandled: Readonly<Record<string, number>>;
  /** Batches executed. */
  batches: number;
  /** True when the run hit its batch ceiling with eligible rows remaining. */
  more: boolean;
}

export interface RunOrderPayloadRedactionSweepOptions {
  db: LoxepDb;
  /** See {@link OrderPayloadRedactors}; defaults to none (a reporting-only run). */
  redactors?: OrderPayloadRedactors;
  /** Reuse an existing settings service instead of creating one. */
  settings?: SettingsService;
  /** Sweep clock; defaults to now. Tests pin it. */
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  logger?: JobsLogger;
}

const MILLIS_PER_DAY = 86_400_000;

/** SQL `in (...)` list of text literals; callers guarantee a non-empty list. */
function objectTypeList(types: readonly string[]): string {
  return types.map((type) => textLiteral(type)).join(", ");
}

/**
 * Run one bounded pass of the ADR-0021 retention sweep.
 *
 * Reads the policy first and returns immediately in `keep` mode: the setting
 * is the whole gate, and an installation that opted out must not pay even a
 * count query.
 */
export async function runOrderPayloadRedactionSweep(
  options: RunOrderPayloadRedactionSweepOptions,
): Promise<OrderPayloadRedactionSweepResult> {
  const { db } = options;
  const redactors = options.redactors ?? {};
  const settings = options.settings ?? createSettingsService({ db });
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_REDACTION_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? DEFAULT_REDACTION_MAX_BATCHES;
  const logger = options.logger;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new CommerceValidationError("batchSize must be a positive integer");
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new CommerceValidationError("maxBatches must be a positive integer");
  }

  const policy = await settings.get(orderPayloadRetentionSetting);
  if (policy.mode === "keep") {
    return {
      mode: "keep",
      afterDays: policy.afterDays,
      cutoff: null,
      scanned: 0,
      redacted: 0,
      alreadyRedacted: 0,
      failed: 0,
      unhandled: {},
      batches: 0,
      more: false,
    };
  }

  const cutoff = new Date(now.getTime() - policy.afterDays * MILLIS_PER_DAY);
  const handledTypes = Object.keys(redactors);
  const unhandledTypes = ORDER_PROVIDER_OBJECT_TYPES.filter(
    (type) => !Object.hasOwn(redactors, type),
  );

  let scanned = 0;
  let redacted = 0;
  let alreadyRedacted = 0;
  let failed = 0;
  let batches = 0;
  let more = false;

  while (handledTypes.length > 0 && batches < maxBatches) {
    const rows = await db.query.providerObjects.findMany({
      where: (table, { and, inArray, isNull, lt }) =>
        and(
          inArray(table.objectType, handledTypes),
          isNull(table.redactedAt),
          lt(table.fetchedAt, cutoff),
        ),
      // Oldest first: the rows that have carried personal data longest are the
      // ones a bounded run should clear first.
      orderBy: (table, { asc }) => [asc(table.fetchedAt)],
      limit: batchSize,
      columns: { id: true, objectType: true, payload: true },
    });
    if (rows.length === 0) break;

    batches += 1;
    scanned += rows.length;
    let progressed = 0;

    for (const row of rows) {
      const redactor = redactors[row.objectType];
      // Unreachable — `handledTypes` is exactly this map's key set — but the
      // narrowing is real and a future caller could widen the query.
      if (redactor === undefined) continue;

      let redactedPayload: Record<string, unknown>;
      try {
        redactedPayload = redactor(
          row.payload as Record<string, unknown>,
        );
        if (
          redactedPayload === null ||
          typeof redactedPayload !== "object" ||
          Array.isArray(redactedPayload)
        ) {
          throw new CommerceValidationError(
            `redactor for "${row.objectType}" returned a non-object payload`,
          );
        }
      } catch (error) {
        failed += 1;
        logger?.warn(
          {
            providerObjectId: row.id,
            objectType: row.objectType,
            error: error instanceof Error ? error.message : String(error),
          },
          "order payload redaction failed; row left verbatim",
        );
        continue;
      }

      // `and redacted_at is null` is the at-least-once guard: a concurrent
      // run, a redelivered job, or a retry after a partial batch updates zero
      // rows here instead of rewriting an already-redacted payload.
      const result = await db.execute(
        `update provider_objects
            set payload = ${jsonbLiteral(redactedPayload)},
                redacted_at = ${timestamptzLiteral(now)}
          where id = ${uuidLiteral(row.id)}
            and redacted_at is null
        returning id`,
      );
      if (result.rows.length === 0) {
        alreadyRedacted += 1;
        continue;
      }
      redacted += 1;
      progressed += 1;
    }

    // A batch that redacted nothing would be re-read identically forever;
    // stop and let the reported `failed` count be the thing that gets fixed.
    if (progressed === 0) break;
    if (rows.length < batchSize) break;
    if (batches >= maxBatches) more = true;
  }

  const unhandled: Record<string, number> = {};
  if (unhandledTypes.length > 0) {
    const counts = await db.execute(
      `select object_type, count(*)::int as eligible
         from provider_objects
        where object_type in (${objectTypeList(unhandledTypes)})
          and redacted_at is null
          and fetched_at < ${timestamptzLiteral(cutoff)}
        group by object_type`,
    );
    for (const row of counts.rows) {
      const type = row["object_type"] as string;
      const eligible = Number(row["eligible"] ?? 0);
      if (eligible > 0) unhandled[type] = eligible;
    }
    if (Object.keys(unhandled).length > 0) {
      logger?.warn(
        { unhandled },
        "order payloads are eligible for redaction but their provider " +
          "supplied no redaction helper; they were left verbatim (ADR-0021 " +
          "requires every adapter with order ingestion to ship one)",
      );
    }
  }

  return {
    mode: "redact",
    afterDays: policy.afterDays,
    cutoff,
    scanned,
    redacted,
    alreadyRedacted,
    failed,
    unhandled,
    batches,
    more,
  };
}
