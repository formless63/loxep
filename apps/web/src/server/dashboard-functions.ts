/**
 * Server functions for `/dashboard/overview` — the four bands of the product
 * home (loxep-jwm).
 *
 * One `requireSession` read per band, one DTO each, so the route can stream
 * four independent `<Suspense>` boundaries instead of blocking on the slowest
 * read (Frontend Standards, "One boundary per data source").
 *
 * ```text
 * fetchDashboardMoney        band 1  orders/fees/net, 30d, daily series
 * fetchDashboardMarketPulse  band 2  events 24h, top opportunity, movers
 * fetchDashboardOperations   band 3  connections, monitor fleet, sync, notifs
 * fetchDashboardFinancial    band 4  income statement for the current period
 * ```
 *
 * ## Why the commerce and accounting reads are queries here, not package calls
 *
 * `@loxep/commerce` exposes `orderSummary`/`entityAttributionReport` and
 * `@loxep/accounting` exposes `createStatements`, and both would be the right
 * things to call — but **neither package is a dependency of `apps/web`**
 * (`apps/web/package.json` declares `@loxep/db`, `-domain`, `-market`,
 * `-notifications`, `-storage`, `-auth`, `-config`, `-integration-ebay`, and
 * nothing else), so neither resolves from this module. Adding those
 * dependency edges is outside this change's write fence, exactly as
 * `@/server/order-sync-functions` documents for `@loxep/commerce`.
 *
 * The reads below therefore go straight to the tables through `@loxep/db`'s
 * pooled handle — the same choice `fetchSearchDashboard` documents in
 * `@/server/market-functions`. Two consequences are load-bearing and are
 * honoured deliberately rather than by accident:
 *
 * - **`reports.ts`'s currency rule.** Amounts are grouped by currency and
 *   NEVER summed across currencies; there is no FX anywhere. The money band
 *   reports ONE currency (the one with the most orders in the window) and
 *   names the others in `otherCurrencies` so the omission is visible rather
 *   than silent. Duplicate-marked orders (`duplicate_of_order_id is not
 *   null`) are excluded from every figure, as every commerce read model does.
 * - **`statements.ts`'s sign convention.** `journal_lines.amount` is signed
 *   and positive is a debit, so revenue is `-sum(functional_amount)`, expense
 *   is `+sum(functional_amount)`, net income is `-(sum over both)`, and only
 *   `posted`/`reversed` entries are in the books. That module is the source
 *   of truth for those rules; this one restates them in SQL and must be
 *   updated with it.
 *
 * All money crosses this API as an exact decimal STRING and every total is
 * computed by PostgreSQL `numeric`, never by JavaScript arithmetic. The one
 * `float8` cast is a percentage — a display-only ratio, computed from exact
 * numeric operands, and labelled as such at each site.
 *
 * Handlers use dynamic imports so `@/server/admin` and the server packages
 * behind it stay out of the client bundle; only type-only imports from server
 * packages appear at the top level here, mirroring `@/server/market-functions`.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { JsonValue } from '@/server/admin-functions';
import { bucketHourly, readOpportunityPayload } from '@/server/market-functions';
import type { MarketOverviewTrendBucketDto, TopOpportunityDto } from '@/server/market-functions';

function iso(date: Date): string;
function iso(date: Date | null | undefined): string | null;
function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

// ---------------------------------------------------------------------------
// SQL literals
//
// This module builds a handful of first-class SQL statements. Every value
// interpolated into one goes through a validator here — the same discipline
// `@loxep/market`'s `sql.ts` enforces for the package-side reads. Time bounds
// are deliberately expressed as PostgreSQL `interval` arithmetic instead of
// interpolated timestamps, so the only values that ever reach a statement are
// a 3-letter currency code, a UUID, an ISO date, and a small integer.
// ---------------------------------------------------------------------------

const uuidSchema = z.uuid();

function uuidLiteral(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new Error('expected a UUID value');
  return `'${parsed.data}'`;
}

function currencyLiteral(value: string): string {
  if (!/^[A-Za-z]{3}$/.test(value)) throw new Error('expected an ISO-4217 currency code');
  return `'${value.toUpperCase()}'`;
}

function dateLiteral(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('expected an ISO calendar date');
  return `'${value}'::date`;
}

function intLiteral(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('expected a non-negative integer');
  return String(value);
}

/** A `numeric`-typed column read back through `db.execute`'s TEXT wire format. */
function decimal(value: unknown): string {
  return value === null || value === undefined ? '0.000000' : String(value);
}

function count(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

/**
 * Percentages arrive from PostgreSQL as `float8` — a display-only ratio
 * derived from exact `numeric` operands (see the module doc). `null` means
 * "no prior-period baseline", which renders as no trend badge rather than as
 * a fabricated 0%.
 */
function pct(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

// ---------------------------------------------------------------------------
// Band 1 — Money
// ---------------------------------------------------------------------------

/** Trailing window every money figure on the dashboard is measured over. */
export const MONEY_WINDOW_DAYS = 30;

export interface DashboardMoneyDayDto {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  grossAmount: string;
  orderCount: number;
}

export interface DashboardMoneyCurrencyDto {
  currency: string;
  orderCount: number;
}

export interface DashboardMoneyDto {
  windowDays: number;
  /**
   * The reported currency: the one with the most orders in the window. Null
   * when the window holds no orders. There is no FX and no reporting
   * currency — see the module doc.
   */
  currency: string | null;
  /** Other currencies in the window, reported so the omission is visible. */
  otherCurrencies: DashboardMoneyCurrencyDto[];
  orderCount: number;
  /** Sum of `orders.total_amount` — what buyers were charged. */
  grossAmount: string;
  /** Sum of `orders.fee_amount`, the provider's own seller-fee rollup. */
  feeAmount: string;
  /** `order_fees` where `fee_direction = 'seller_charge'`, in the order's currency. */
  sellerChargeFeeAmount: string;
  /**
   * `order_fees` where `fee_direction = 'buyer_surcharge'` — reported for
   * transparency and NEVER subtracted: a buyer surcharge is already inside
   * `total_amount` and is not a deduction from proceeds.
   */
  buyerSurchargeAmount: string;
  refundedAmount: string;
  /** `gross - fees - refunds`: contribution BEFORE cost of goods, not margin. */
  netAmount: string;
  /** One row per UTC day across the window; a day with no orders is a real 0. */
  daily: DashboardMoneyDayDto[];
  /** Trailing 7d vs. the 7d before it. Null when the prior week had none. */
  revenueTrendPct: number | null;
  orderTrendPct: number | null;
  /** Orders ingested at any time, ever — distinguishes "quiet month" from "not connected". */
  lifetimeOrderCount: number;
}

export const fetchDashboardMoney = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardMoneyDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const windowClause = `o.placed_at >= now() - interval '${intLiteral(MONEY_WINDOW_DAYS)} days'`;

    const [currencies, lifetime] = await Promise.all([
      handle.db.execute(
        `select o.currency, count(*)::int as order_count
           from orders o
          where o.duplicate_of_order_id is null
            and ${windowClause}
          group by o.currency
          order by count(*) desc, o.currency asc`
      ),
      handle.db.execute(
        `select count(*)::int as order_count
           from orders o
          where o.duplicate_of_order_id is null`
      )
    ]);

    const lifetimeOrderCount = count(lifetime.rows[0]?.['order_count']);
    const groups = currencies.rows.map((row) => ({
      currency: row['currency'] as string,
      orderCount: count(row['order_count'])
    }));
    const primary = groups[0];

    if (primary === undefined) {
      return {
        windowDays: MONEY_WINDOW_DAYS,
        currency: null,
        otherCurrencies: [],
        orderCount: 0,
        grossAmount: '0.000000',
        feeAmount: '0.000000',
        sellerChargeFeeAmount: '0.000000',
        buyerSurchargeAmount: '0.000000',
        refundedAmount: '0.000000',
        netAmount: '0.000000',
        daily: [],
        revenueTrendPct: null,
        orderTrendPct: null,
        lifetimeOrderCount
      };
    }

    const currency = currencyLiteral(primary.currency);
    // The fee roll-ups are correlated sub-selects, never a join onto
    // `order_fees` before aggregating — joining first multiplies
    // `total_amount` by the fee-row count, which is the classic way a
    // profitability report silently triples its revenue (`reports.ts`).
    const [totals, daily, trend] = await Promise.all([
      handle.db.execute(
        `select count(*)::int as order_count,
                coalesce(sum(o.total_amount), 0)::numeric(20, 6)::text as gross_amount,
                coalesce(sum(o.fee_amount), 0)::numeric(20, 6)::text as fee_amount,
                coalesce(sum(o.refunded_amount), 0)::numeric(20, 6)::text as refunded_amount,
                coalesce(sum(o.total_amount) - sum(o.fee_amount)
                         - sum(o.refunded_amount), 0)::numeric(20, 6)::text as net_amount,
                coalesce(sum((select coalesce(sum(f.amount), 0)
                                from order_fees f
                               where f.order_id = o.id
                                 and f.fee_direction = 'seller_charge'
                                 and f.currency = o.currency)), 0)::numeric(20, 6)::text
                  as seller_charge_fee_amount,
                coalesce(sum((select coalesce(sum(f.amount), 0)
                                from order_fees f
                               where f.order_id = o.id
                                 and f.fee_direction = 'buyer_surcharge'
                                 and f.currency = o.currency)), 0)::numeric(20, 6)::text
                  as buyer_surcharge_amount
           from orders o
          where o.duplicate_of_order_id is null
            and o.currency = ${currency}
            and ${windowClause}`
      ),
      handle.db.execute(
        `with days as (
            select generate_series(
              (date_trunc('day', now() at time zone 'UTC')
                 - interval '${intLiteral(MONEY_WINDOW_DAYS - 1)} days')::date,
              (date_trunc('day', now() at time zone 'UTC'))::date,
              interval '1 day'
            )::date as day
          )
          select d.day::text as day,
                 coalesce(sum(o.total_amount), 0)::numeric(20, 6)::text as gross_amount,
                 count(o.id)::int as order_count
            from days d
            left join orders o
              on (o.placed_at at time zone 'UTC')::date = d.day
             and o.duplicate_of_order_id is null
             and o.currency = ${currency}
           group by d.day
           order by d.day`
      ),
      handle.db.execute(
        `with windows as (
            select coalesce(sum(o.total_amount)
                     filter (where o.placed_at >= now() - interval '7 days'), 0) as recent_gross,
                   coalesce(sum(o.total_amount)
                     filter (where o.placed_at >= now() - interval '14 days'
                               and o.placed_at < now() - interval '7 days'), 0) as prior_gross,
                   count(*) filter (where o.placed_at >= now() - interval '7 days') as recent_orders,
                   count(*) filter (where o.placed_at >= now() - interval '14 days'
                                      and o.placed_at < now() - interval '7 days') as prior_orders
              from orders o
             where o.duplicate_of_order_id is null
               and o.currency = ${currency}
          )
          select case when prior_gross > 0
                      then ((recent_gross - prior_gross) / prior_gross * 100)::float8
                 end as revenue_trend_pct,
                 case when prior_orders > 0
                      then ((recent_orders - prior_orders)::numeric / prior_orders * 100)::float8
                 end as order_trend_pct
            from windows`
      )
    ]);

    const totalsRow = totals.rows[0];
    const trendRow = trend.rows[0];
    return {
      windowDays: MONEY_WINDOW_DAYS,
      currency: primary.currency,
      otherCurrencies: groups.slice(1),
      orderCount: count(totalsRow?.['order_count']),
      grossAmount: decimal(totalsRow?.['gross_amount']),
      feeAmount: decimal(totalsRow?.['fee_amount']),
      sellerChargeFeeAmount: decimal(totalsRow?.['seller_charge_fee_amount']),
      buyerSurchargeAmount: decimal(totalsRow?.['buyer_surcharge_amount']),
      refundedAmount: decimal(totalsRow?.['refunded_amount']),
      netAmount: decimal(totalsRow?.['net_amount']),
      daily: daily.rows.map((row) => ({
        day: row['day'] as string,
        grossAmount: decimal(row['gross_amount']),
        orderCount: count(row['order_count'])
      })),
      revenueTrendPct: pct(trendRow?.['revenue_trend_pct']),
      orderTrendPct: pct(trendRow?.['order_trend_pct']),
      lifetimeOrderCount
    };
  }
);

// ---------------------------------------------------------------------------
// Band 2 — Market pulse
// ---------------------------------------------------------------------------

const MOVERS_LIMIT = 5;
const MOVERS_WINDOW_HOURS = 7 * 24;
const TOP_OPPORTUNITY_SCAN_LIMIT = 50;
const HOUR_MS = 60 * 60 * 1000;

export interface DashboardPriceMoverDto {
  marketplaceItemId: string;
  title: string | null;
  currency: string | null;
  latestPrice: string;
  previousPrice: string;
  /** Signed percent change between the last two priced observations. */
  priceChangePct: number;
  observedAt: string;
}

export interface DashboardMarketPulseDto {
  activeMonitorCount: number;
  watchedItemCount: number;
  eventsLast24hCount: number;
  /** Hourly buckets across the trailing 24h; feeds the band's area chart. */
  eventsTrend: MarketOverviewTrendBucketDto[];
  topOpportunity: TopOpportunityDto | null;
  /** Up to five items whose price moved most in the last week; may be empty. */
  movers: DashboardPriceMoverDto[];
  moversWindowHours: number;
}

export const fetchDashboardMarketPulse = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardMarketPulseDto> => {
    const { requireSession, getAdminServices, getMarketModule } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();
    const market = await getMarketModule();
    const since = new Date(Date.now() - 24 * HOUR_MS);

    const [activeMonitors, watchedItems, events24h, recentOpportunities, movers] =
      await Promise.all([
        handle.db.query.monitorTargets.findMany({
          where: (table, { eq }) => eq(table.enabled, true),
          columns: { id: true }
        }),
        handle.db.query.marketplaceItems.findMany({ columns: { id: true } }),
        handle.db.query.marketEvents.findMany({
          where: (table, { gt }) => gt(table.detectedAt, since),
          columns: { id: true, detectedAt: true }
        }),
        handle.db.query.marketEvents.findMany({
          where: (table, { isNotNull }) => isNotNull(table.ruleId),
          orderBy: (table, { desc }) => [desc(table.detectedAt)],
          limit: TOP_OPPORTUNITY_SCAN_LIMIT
        }),
        market.biggestPriceMovers(handle.db, {
          limit: MOVERS_LIMIT,
          since: new Date(Date.now() - MOVERS_WINDOW_HOURS * HOUR_MS)
        })
      ]);

    // "Top of the last N", not "top of all time": `market_events` has no index
    // on `payload->'opportunity'->>'score'`, so this stays an ordinary
    // `detected_at DESC LIMIT` read (same trade-off as `fetchMarketOverview`).
    let topOpportunity: TopOpportunityDto | null = null;
    for (const event of recentOpportunities) {
      const opportunity = readOpportunityPayload(event.payload as Record<string, JsonValue>);
      if (opportunity === null) continue;
      if (topOpportunity === null || opportunity.score > topOpportunity.score) {
        topOpportunity = {
          id: event.id,
          marketplaceItemId: event.marketplaceItemId,
          itemTitle: null,
          ruleId: opportunity.ruleId,
          ruleName: opportunity.ruleName,
          score: opportunity.score,
          detectedAt: iso(event.detectedAt)
        };
      }
    }
    if (topOpportunity !== null) {
      const winner = topOpportunity;
      const item = await handle.db.query.marketplaceItems.findFirst({
        where: (table, { eq }) => eq(table.id, winner.marketplaceItemId),
        columns: { title: true }
      });
      topOpportunity = { ...winner, itemTitle: item?.title ?? null };
    }

    return {
      activeMonitorCount: activeMonitors.length,
      watchedItemCount: watchedItems.length,
      eventsLast24hCount: events24h.length,
      eventsTrend: bucketHourly(events24h, since),
      topOpportunity,
      moversWindowHours: MOVERS_WINDOW_HOURS,
      movers: movers.map((mover) => ({
        marketplaceItemId: mover.marketplaceItemId,
        title: mover.title,
        currency: mover.currency,
        latestPrice: mover.latestPrice,
        previousPrice: mover.previousPrice,
        priceChangePct: mover.priceChangePct,
        observedAt: iso(mover.observedAt)
      }))
    };
  }
);

// ---------------------------------------------------------------------------
// Band 3 — Operations health
// ---------------------------------------------------------------------------

/** Mirrors `@/server/order-sync-functions`' target types (same re-declaration reason). */
const ORDER_SYNC_TARGET_TYPES = ['woo_orders', 'ebay_orders'] as const;
type OrderSyncTargetType = (typeof ORDER_SYNC_TARGET_TYPES)[number];

/** Delivery-success window; matches the design's "7d" notification tile. */
export const NOTIFICATION_WINDOW_DAYS = 7;

/**
 * A sync target is stale once it has gone longer than twice its own poll
 * interval without a success — one missed cycle is scheduling jitter, two is
 * a signal.
 */
const STALE_INTERVAL_MULTIPLIER = 2;

export interface DashboardProviderHealthDto {
  provider: string;
  total: number;
  active: number;
  disabled: number;
  archived: number;
  /** Connections whose most recent recorded outcome was an error. */
  errored: number;
}

export interface DashboardMonitorFleetDto {
  /** Excludes order-sync targets — those get their own tile below. */
  total: number;
  enabled: number;
  disabled: number;
  /** Enabled targets carrying a non-zero consecutive-error streak. */
  erroring: number;
  /** Enabled targets currently held off by backoff. */
  backingOff: number;
  /** Enabled targets whose next poll was due more than one interval ago. */
  overdue: number;
  lastSuccessAt: string | null;
  /** Soonest upcoming poll across enabled targets. */
  nextPollAt: string | null;
}

export interface DashboardOrderSyncDto {
  id: string;
  name: string;
  targetType: OrderSyncTargetType;
  connectionName: string | null;
  enabled: boolean;
  intervalSeconds: number;
  lastSuccessAt: string | null;
  consecutiveErrors: number;
  /** Enabled, and no success within twice its interval (or none ever). */
  stale: boolean;
}

export interface DashboardNotificationHealthDto {
  windowDays: number;
  total: number;
  delivered: number;
  failed: number;
  pending: number;
  /** `delivered / (delivered + failed)`; null when nothing settled yet. */
  successRatePct: number | null;
}

export interface DashboardOperationsDto {
  providers: DashboardProviderHealthDto[];
  connectionCount: number;
  monitors: DashboardMonitorFleetDto;
  orderSync: DashboardOrderSyncDto[];
  notifications: DashboardNotificationHealthDto;
}

export const fetchDashboardOperations = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardOperationsDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const admin = getAdminServices();
    const { handle } = admin;

    const [connections, targets, deliveries] = await Promise.all([
      admin.connections.listConnections(),
      handle.db.query.monitorTargets.findMany(),
      handle.db.execute(
        `select status, count(*)::int as n
           from notification_deliveries
          where created_at >= now() - interval '${intLiteral(NOTIFICATION_WINDOW_DAYS)} days'
          group by status`
      )
    ]);

    const byProvider = new Map<string, DashboardProviderHealthDto>();
    for (const connection of connections) {
      const bucket = byProvider.get(connection.provider) ?? {
        provider: connection.provider,
        total: 0,
        active: 0,
        disabled: 0,
        archived: 0,
        errored: 0
      };
      bucket.total += 1;
      if (connection.status === 'active') bucket.active += 1;
      else if (connection.status === 'disabled') bucket.disabled += 1;
      else if (connection.status === 'archived') bucket.archived += 1;
      // "Most recent outcome was an error": an error with no later success.
      // A connection that has errored once and recovered is healthy.
      if (
        connection.lastErrorAt !== null &&
        (connection.lastSuccessAt === null ||
          connection.lastErrorAt.getTime() > connection.lastSuccessAt.getTime())
      ) {
        bucket.errored += 1;
      }
      byProvider.set(connection.provider, bucket);
    }

    const now = Date.now();
    const orderSyncTypes = new Set<string>(ORDER_SYNC_TARGET_TYPES);
    const fleet = targets.filter((target) => !orderSyncTypes.has(target.targetType));
    const enabled = fleet.filter((target) => target.enabled);
    const successInstants = fleet
      .map((target) => target.lastSuccessAt)
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());
    const nextPollInstants = enabled
      .map((target) => target.nextPollAt)
      .filter((value): value is Date => value !== null)
      .map((value) => value.getTime());

    const connectionNameById = new Map(connections.map((row) => [row.id, row.name]));
    const orderSync = targets
      .filter((target) => orderSyncTypes.has(target.targetType))
      .map((target) => ({
        id: target.id,
        name: target.name,
        targetType: target.targetType as OrderSyncTargetType,
        connectionName: target.connectionId
          ? (connectionNameById.get(target.connectionId) ?? null)
          : null,
        enabled: target.enabled,
        intervalSeconds: target.intervalSeconds,
        lastSuccessAt: iso(target.lastSuccessAt),
        consecutiveErrors: target.consecutiveErrors,
        stale:
          target.enabled &&
          (target.lastSuccessAt === null ||
            now - target.lastSuccessAt.getTime() >
              STALE_INTERVAL_MULTIPLIER * target.intervalSeconds * 1000)
      }));
    // `.sort()` mutates in place — `orderSync` is a fresh array built by the
    // `.map()` above, so there is nothing shared to disturb (same convention
    // as `features/market/lib/sort-rows.ts`).
    orderSync.sort((left, right) => left.name.localeCompare(right.name));

    const providers = [...byProvider.values()];
    providers.sort((left, right) => left.provider.localeCompare(right.provider));

    const deliveryCounts = new Map<string, number>();
    for (const row of deliveries.rows) {
      deliveryCounts.set(row['status'] as string, count(row['n']));
    }
    const delivered = deliveryCounts.get('delivered') ?? 0;
    const failed = deliveryCounts.get('failed') ?? 0;
    const pending = deliveryCounts.get('pending') ?? 0;
    const settled = delivered + failed;

    return {
      connectionCount: connections.length,
      providers,
      monitors: {
        total: fleet.length,
        enabled: enabled.length,
        disabled: fleet.length - enabled.length,
        erroring: enabled.filter((target) => target.consecutiveErrors > 0).length,
        backingOff: enabled.filter(
          (target) => target.backoffUntil !== null && target.backoffUntil.getTime() > now
        ).length,
        overdue: enabled.filter(
          (target) =>
            target.nextPollAt !== null &&
            now - target.nextPollAt.getTime() > target.intervalSeconds * 1000
        ).length,
        lastSuccessAt:
          successInstants.length === 0
            ? null
            : new Date(Math.max(...successInstants)).toISOString(),
        nextPollAt:
          nextPollInstants.length === 0
            ? null
            : new Date(Math.min(...nextPollInstants)).toISOString()
      },
      orderSync,
      notifications: {
        windowDays: NOTIFICATION_WINDOW_DAYS,
        total: delivered + failed + pending,
        delivered,
        failed,
        pending,
        // Counts, not money — plain integer arithmetic is fine here.
        successRatePct: settled === 0 ? null : (delivered / settled) * 100
      }
    };
  }
);

// ---------------------------------------------------------------------------
// Band 4 — Financial statements
// ---------------------------------------------------------------------------

/** Mirrors `@loxep/accounting`'s `DEFAULT_BOOK_SETTING_KEY`. */
const DEFAULT_BOOK_SETTING_KEY = 'accounting.default_book_id';
/** Entry statuses whose lines are in the books (`statements.ts`). */
const IN_THE_BOOKS = "('posted', 'reversed')";
const EXPENSE_LINE_LIMIT = 6;

export interface DashboardBookDto {
  id: string;
  code: string;
  name: string;
  functionalCurrency: string;
}

export interface DashboardPeriodDto {
  code: string;
  startsOn: string;
  endsOn: string;
  status: string;
}

export interface DashboardExpenseLineDto {
  code: string;
  name: string;
  /** Presentation-signed: positive is cost. */
  amount: string;
}

export interface DashboardFinancialDto {
  /** Null when no accounting book exists — the band renders an Empty state. */
  book: DashboardBookDto | null;
  bookCount: number;
  /** Null when no fiscal period covers today; the figures are then null too. */
  period: DashboardPeriodDto | null;
  /** Presentation-signed income-statement totals, or null with no period. */
  revenue: string | null;
  expenses: string | null;
  netIncome: string | null;
  /** Largest expense accounts in the period, at most {@link EXPENSE_LINE_LIMIT}. */
  expenseLines: DashboardExpenseLineDto[];
}

const EMPTY_FINANCIAL: DashboardFinancialDto = {
  book: null,
  bookCount: 0,
  period: null,
  revenue: null,
  expenses: null,
  netIncome: null,
  expenseLines: []
};

export const fetchDashboardFinancial = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardFinancialDto> => {
    const { requireSession, getAdminServices } = await import('@/server/admin');
    await requireSession();
    const { handle } = getAdminServices();

    const [books, defaultSetting] = await Promise.all([
      handle.db.query.accountingBooks.findMany({
        orderBy: (table, { asc }) => [asc(table.openedOn), asc(table.createdAt)]
      }),
      handle.db.query.applicationSettings.findFirst({
        where: (table, { eq }) => eq(table.key, DEFAULT_BOOK_SETTING_KEY)
      })
    ]);
    if (books.length === 0) return EMPTY_FINANCIAL;

    // The installation default when one is configured; otherwise the oldest
    // active book — a single-book installation (the common case) never has to
    // configure anything for this band to be right.
    const configuredId =
      typeof defaultSetting?.value === 'string' &&
      uuidSchema.safeParse(defaultSetting.value).success
        ? defaultSetting.value
        : null;
    const resolved =
      books.find((row) => row.id === configuredId) ??
      books.find((row) => row.status === 'active') ??
      books[0];
    if (resolved === undefined) return EMPTY_FINANCIAL;

    const book: DashboardBookDto = {
      id: resolved.id,
      code: resolved.code,
      name: resolved.name,
      functionalCurrency: resolved.functionalCurrency
    };

    // Today as a UTC calendar date rather than the database's `current_date`:
    // fiscal period bounds are calendar dates with no timezone, and pinning
    // the comparison to UTC keeps "which period is current" independent of the
    // database session's timezone.
    const today = new Date().toISOString().slice(0, 10);
    const periodRow = await handle.db.query.fiscalPeriods.findFirst({
      where: (table, { and, eq, lte, gte }) =>
        and(
          eq(table.accountingBookId, resolved.id),
          lte(table.startsOn, today),
          gte(table.endsOn, today)
        ),
      orderBy: (table, { desc }) => [desc(table.startsOn)]
    });
    if (periodRow === undefined) {
      return { ...EMPTY_FINANCIAL, book, bookCount: books.length };
    }

    const bookLiteral = uuidLiteral(resolved.id);
    const from = dateLiteral(periodRow.startsOn);
    const to = dateLiteral(periodRow.endsOn);
    // `statements.ts`'s sign convention, restated: debits are positive, so
    // revenue flips and expense does not, and net income is the negation of
    // the sum over BOTH — which is why it can never disagree with the two
    // sections above it.
    const [totals, lines] = await Promise.all([
      handle.db.execute(
        `select coalesce(-sum(l.functional_amount)
                  filter (where a.account_type = 'revenue'), 0)::numeric(20, 6)::text as revenue,
                coalesce(sum(l.functional_amount)
                  filter (where a.account_type = 'expense'), 0)::numeric(20, 6)::text as expenses,
                coalesce(-sum(l.functional_amount), 0)::numeric(20, 6)::text as net_income
           from journal_lines l
           join journal_entries e on e.id = l.journal_entry_id
           join ledger_accounts a on a.id = l.ledger_account_id
          where l.accounting_book_id = ${bookLiteral}
            and a.account_type in ('revenue', 'expense')
            and e.status in ${IN_THE_BOOKS}
            and e.entry_date >= ${from}
            and e.entry_date <= ${to}`
      ),
      handle.db.execute(
        `select a.code, a.name,
                agg.balance::numeric(20, 6)::text as balance
           from ledger_accounts a
           join (
             select l.ledger_account_id, sum(l.functional_amount) as balance
               from journal_lines l
               join journal_entries e on e.id = l.journal_entry_id
              where l.accounting_book_id = ${bookLiteral}
                and e.status in ${IN_THE_BOOKS}
                and e.entry_date >= ${from}
                and e.entry_date <= ${to}
              group by l.ledger_account_id
           ) agg on agg.ledger_account_id = a.id
          where a.accounting_book_id = ${bookLiteral}
            and a.account_type = 'expense'
            and a.is_postable = true
          order by agg.balance desc, a.code asc
          limit ${intLiteral(EXPENSE_LINE_LIMIT)}`
      )
    ]);

    const totalsRow = totals.rows[0];
    return {
      book,
      bookCount: books.length,
      period: {
        code: periodRow.periodCode,
        startsOn: periodRow.startsOn,
        endsOn: periodRow.endsOn,
        status: periodRow.status
      },
      revenue: decimal(totalsRow?.['revenue']),
      expenses: decimal(totalsRow?.['expenses']),
      netIncome: decimal(totalsRow?.['net_income']),
      // A contra expense account carries a credit balance and is NOT flipped
      // again — the presentation sign is `sum(functional_amount)` as-is.
      expenseLines: lines.rows.map((row) => ({
        code: row['code'] as string,
        name: row['name'] as string,
        amount: decimal(row['balance'])
      }))
    };
  }
);
