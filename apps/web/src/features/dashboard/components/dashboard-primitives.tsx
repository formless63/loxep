/**
 * Shared composition primitives for the `/dashboard/overview` bands
 * (loxep-jwm).
 *
 * These generalize the pieces `/market/overview` proved out — the focus-ring
 * link wrapper, the KPI `StatCard` with its trend badge / tinted icon
 * medallion / in-tile sparkline, and the grid tint that makes a row of tiles
 * read as one group — so all four bands are built from one vocabulary
 * instead of four hand-rolled ones (Frontend Standards, "KPI and stat cards").
 *
 * The rule those pieces exist to enforce: a tile with a real derived series
 * gets a sparkline, a tile without one gets a `--chart-N` icon medallion, and
 * NOTHING gets a fabricated series to fill the slot.
 */
import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Area, AreaChart } from 'recharts';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle
} from '@/components/ui/card';
import { ChartContainer, type ChartConfig } from '@/components/ui/chart';
import { Icons, type Icon } from '@/components/icons';
import { cn } from '@/lib/utils';

export type RouteTarget = React.ComponentProps<typeof Link>['to'];

/**
 * The one grid-level tint every band's tile row carries, so a band reads as a
 * group rather than as loose cards on the page ground. Token-driven
 * (`--primary`), so it moves with the theme.
 */
export const BAND_GRID_TINT =
  '[&_[data-slot=card]]:bg-gradient-to-t [&_[data-slot=card]]:from-primary/5 [&_[data-slot=card]]:to-card [&_[data-slot=card]]:shadow-xs dark:[&_[data-slot=card]]:bg-card';

/** Every card that navigates gets the same visible focus ring. */
export function FocusableLink({
  to,
  className,
  children
}: {
  to: RouteTarget;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        'block rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      {children}
    </Link>
  );
}

/** A tinted chart-token medallion for tiles with no real series to sparkline. */
export function StatIcon({ icon: IconComponent, className }: { icon: Icon; className: string }) {
  return (
    <span
      className={cn('flex size-9 shrink-0 items-center justify-center rounded-full', className)}
    >
      <IconComponent className='size-5' />
    </span>
  );
}

export interface StatTrend {
  direction: 'up' | 'down';
  label: string;
}

/**
 * Build a trend badge from a signed percentage, or nothing at all when there
 * is no prior-period baseline. A missing baseline renders NO badge rather
 * than a fabricated `+0.00%`.
 */
export function trendFrom(pct: number | null | undefined, label: string): StatTrend | undefined {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return undefined;
  return { direction: pct >= 0 ? 'up' : 'down', label };
}

export function StatCard({
  label,
  value,
  href,
  trend,
  icon,
  sparkline,
  footer,
  className,
  valueClassName
}: {
  label: string;
  value: React.ReactNode;
  href?: RouteTarget;
  trend?: StatTrend;
  icon?: { icon: Icon; className: string };
  sparkline?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  const card = (
    <Card className='@container/card h-full'>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle
          className={cn(
            'text-2xl font-semibold tabular-nums @[250px]/card:text-3xl',
            valueClassName
          )}
        >
          {value}
        </CardTitle>
        {trend && (
          <CardAction>
            <Badge variant='outline'>
              {trend.direction === 'up' ? <Icons.trendingUp /> : <Icons.trendingDown />}
              {trend.label}
            </Badge>
          </CardAction>
        )}
        {icon && !trend && (
          <CardAction>
            <StatIcon icon={icon.icon} className={icon.className} />
          </CardAction>
        )}
      </CardHeader>
      {(sparkline || footer) && (
        <CardFooter className='flex-col items-start gap-2 text-sm'>
          {sparkline}
          {footer && <div className='text-muted-foreground'>{footer}</div>}
        </CardFooter>
      )}
    </Card>
  );

  const wrapped = href ? <FocusableLink to={href}>{card}</FocusableLink> : card;
  return <div className={cn('min-w-0', className)}>{wrapped}</div>;
}

/**
 * Minimal in-tile sparkline — no axis, no tooltip, no grid: the `CardTitle`
 * above it already carries the value, so the mark is there to show shape.
 * `height` lets the hero tile plot a taller series than a 1×1 neighbour.
 */
export function TileSparkline<T>({
  data,
  dataKey,
  config,
  gradientId,
  height = 'h-8'
}: {
  data: T[];
  dataKey: string;
  config: ChartConfig;
  gradientId: string;
  height?: string;
}) {
  const colorVar = `var(--color-${dataKey})`;
  return (
    <ChartContainer config={config} className={cn('aspect-auto w-full', height)}>
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1='0' y1='0' x2='0' y2='1'>
            <stop offset='5%' stopColor={colorVar} stopOpacity={0.4} />
            <stop offset='95%' stopColor={colorVar} stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <Area
          dataKey={dataKey}
          type='monotone'
          stroke={colorVar}
          fill={`url(#${gradientId})`}
          strokeWidth={1.5}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

/**
 * A band header: what this row of the dashboard answers, plus the link to the
 * surface that owns it. Every band has one, so the page reads as four
 * questions rather than sixteen loose cards.
 */
export function BandHeader({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: { label: string; to: RouteTarget };
}) {
  return (
    <div className='flex flex-wrap items-end justify-between gap-2'>
      <div className='min-w-0'>
        <h2 className='text-base font-semibold tracking-tight'>{title}</h2>
        <p className='text-sm text-muted-foreground'>{description}</p>
      </div>
      {action && (
        <Link
          to={action.to}
          className='rounded-md text-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** A band's outer frame: header, then whatever grid the band composes. */
export function Band({
  title,
  description,
  action,
  children
}: {
  title: string;
  description: string;
  action?: { label: string; to: RouteTarget };
  children: React.ReactNode;
}) {
  return (
    <section className='flex flex-col gap-3'>
      <BandHeader title={title} description={description} action={action} />
      {children}
    </section>
  );
}

/** A panel card with a title/description header — the non-KPI tile shape. */
export function PanelCard({
  title,
  description,
  action,
  className,
  contentClassName,
  children
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
  contentClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <Card className='@container/card h-full'>
        <CardHeader>
          <CardTitle className='text-base'>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
          {action && <CardAction>{action}</CardAction>}
        </CardHeader>
        <CardContent className={contentClassName}>{children}</CardContent>
      </Card>
    </div>
  );
}
