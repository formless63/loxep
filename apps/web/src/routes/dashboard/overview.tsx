/**
 * `/dashboard/overview` — the Loxep product home (loxep-jwm; refreshed by
 * loxep-9m2 for the six domains that shipped after it).
 *
 * Four bands answering "how is my operation doing right now", each from real
 * data only: money from ingested orders (including the manual/offline
 * channel-listing funnel), market pulse from derived events, operations
 * health from connections/the full polling fleet (discovery monitors, order
 * sync, purchase sync, DNS reconcile)/this installation's own DNS and
 * hosting estate/fleet-tool signals/deliveries, and the income statement
 * (plus draft-acquisition and unconfirmed-document backlog, which sit
 * upstream of it) once a set of books exists.
 *
 * Above the bands: `OnboardingOidcPromptCard` (ADR-0024 §2, loxep-yk8), a
 * dismissible one-time surface offering to open OIDC auto-provisioning right
 * after the installation's first administrator exists. It is not part of the
 * loader's prefetch — it fetches and renders itself, and renders nothing at
 * all once its own conditions say not to show it.
 *
 * ## Loading shape
 *
 * The route loader warms all four queries with `ensureQueryData` and each
 * band reads its own with `useSuspenseQuery`, per Frontend Standards'
 * Suspense reference pattern (`/market/overview`). Two deliberate departures
 * from that single-DTO reference, both because this route has FOUR genuinely
 * independent data sources rather than one:
 *
 * - The loader uses `Promise.allSettled`, not `await Promise.all`. A rejected
 *   band must not take the whole page down with a route-level
 *   `errorComponent` — the rejection stays in the query cache, is re-thrown by
 *   that band's `useSuspenseQuery`, and is caught by that band's own
 *   `CatchBoundary`. The other three still render.
 * - Each band gets its own `<CatchBoundary>` + `<Suspense>` pair, so a slow
 *   band streams in without blocking its neighbours and a broken one degrades
 *   to a retryable alert in place ("one boundary per data source").
 *
 * As on `/market/overview`, the `<Suspense>` fallbacks are defence-in-depth
 * for a mount that races ahead of the loader (a client-side cache eviction),
 * not the primary loading path — the loader prefetch is.
 */
import * as React from 'react';
import { CatchBoundary, createFileRoute, useRouter } from '@tanstack/react-router';
import type { ErrorComponentProps } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import {
  dashboardFinancialQuery,
  dashboardMarketPulseQuery,
  dashboardMoneyQuery,
  dashboardOperationsQuery
} from '@/features/dashboard/api/queries';
import {
  FinancialBandSkeleton,
  MarketPulseBandSkeleton,
  MoneyBandSkeleton,
  OperationsBandSkeleton
} from '@/features/dashboard/components/band-skeletons';
import { FinancialBand } from '@/features/dashboard/components/financial-band';
import { MarketPulseBand } from '@/features/dashboard/components/market-pulse-band';
import { MoneyBand } from '@/features/dashboard/components/money-band';
import { OnboardingOidcPromptCard } from '@/features/dashboard/components/onboarding-oidc-prompt-card';
import { OperationsBand } from '@/features/dashboard/components/operations-band';

export const Route = createFileRoute('/dashboard/overview')({
  loader: async ({ context: { queryClient } }) => {
    // `allSettled`, deliberately — see the module doc: one band's failure is
    // that band's problem, not the page's.
    await Promise.allSettled([
      queryClient.ensureQueryData(dashboardMoneyQuery),
      queryClient.ensureQueryData(dashboardMarketPulseQuery),
      queryClient.ensureQueryData(dashboardOperationsQuery),
      queryClient.ensureQueryData(dashboardFinancialQuery)
    ]);
  },
  component: DashboardOverview
});

/**
 * Built once per band at module scope, never inside a render: an inline
 * `errorComponent` closure would be a new component type on every render,
 * which remounts the boundary's subtree.
 */
function bandErrorComponent(title: string) {
  return function BandError({ error }: ErrorComponentProps) {
    const router = useRouter();
    return (
      <QueryErrorAlert
        error={error}
        title={`${title} unavailable`}
        onRetry={() => void router.invalidate()}
      />
    );
  };
}

const BAND_ERRORS = {
  money: bandErrorComponent('Money'),
  marketPulse: bandErrorComponent('Market pulse'),
  operations: bandErrorComponent('Operations'),
  financial: bandErrorComponent('Financial')
} as const;

/**
 * One band's boundary pair. `CatchBoundary` (router) rather than the route's
 * `errorComponent`, because the failure has to be contained to this band; the
 * retry re-runs the loader through `router.invalidate()`, which is the same
 * retry action the route-level pattern uses.
 */
function BandBoundary({
  resetKey,
  errorComponent,
  fallback,
  children
}: {
  resetKey: string;
  errorComponent: ReturnType<typeof bandErrorComponent>;
  fallback: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <CatchBoundary getResetKey={() => resetKey} errorComponent={errorComponent}>
      <React.Suspense fallback={fallback}>{children}</React.Suspense>
    </CatchBoundary>
  );
}

function MoneyBandData() {
  const { data } = useSuspenseQuery(dashboardMoneyQuery);
  return <MoneyBand data={data} />;
}

function MarketPulseBandData() {
  const { data } = useSuspenseQuery(dashboardMarketPulseQuery);
  return <MarketPulseBand data={data} />;
}

function OperationsBandData() {
  const { data } = useSuspenseQuery(dashboardOperationsQuery);
  return <OperationsBand data={data} />;
}

function FinancialBandData() {
  const { data } = useSuspenseQuery(dashboardFinancialQuery);
  return <FinancialBand data={data} />;
}

function DashboardOverview() {
  return (
    <div className='flex flex-1 flex-col gap-6 p-4 pt-0'>
      <div>
        <h1 className='text-2xl font-semibold tracking-tight'>Dashboard</h1>
        <p className='text-muted-foreground'>
          Money, market, operations — including this installation's own DNS/hosting estate and
          fleet-tool signals — and the ledger, from real data only.
        </p>
      </div>

      <OnboardingOidcPromptCard />

      <BandBoundary
        resetKey='money'
        errorComponent={BAND_ERRORS.money}
        fallback={<MoneyBandSkeleton />}
      >
        <MoneyBandData />
      </BandBoundary>

      <BandBoundary
        resetKey='market-pulse'
        errorComponent={BAND_ERRORS.marketPulse}
        fallback={<MarketPulseBandSkeleton />}
      >
        <MarketPulseBandData />
      </BandBoundary>

      <BandBoundary
        resetKey='operations'
        errorComponent={BAND_ERRORS.operations}
        fallback={<OperationsBandSkeleton />}
      >
        <OperationsBandData />
      </BandBoundary>

      <BandBoundary
        resetKey='financial'
        errorComponent={BAND_ERRORS.financial}
        fallback={<FinancialBandSkeleton />}
      >
        <FinancialBandData />
      </BandBoundary>
    </div>
  );
}
