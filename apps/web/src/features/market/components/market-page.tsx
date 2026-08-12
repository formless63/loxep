import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Icons } from '@/components/icons';

/** Shared page frame for market surfaces: heading, blurb, optional actions. */
export function MarketPage({
  title,
  description,
  actions,
  children
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className='flex flex-1 flex-col gap-4 p-4 pt-0'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div>
          <h1 className='text-2xl font-semibold tracking-tight'>{title}</h1>
          <p className='text-muted-foreground'>{description}</p>
        </div>
        {actions && <div className='flex items-center gap-2'>{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Boolean status pill used across the market tables (loxep-foi.5). `ok` maps
 * to `success` (healthy); `!ok` maps to `warning`, not `destructive` — this
 * badge's one caller today (`monitors-table`) uses it for an
 * operator-toggled enabled/disabled state, an operator-caused condition, not
 * a genuine failure (Frontend Standards, "Status and health tone"). Every
 * tone is paired with an icon so meaning survives `mono`/`notebook`.
 */
export function StatusBadge({
  ok,
  okLabel,
  failLabel
}: {
  ok: boolean;
  okLabel: string;
  failLabel: string;
}) {
  const Icon = ok ? Icons.circleCheck : Icons.alertCircle;
  return (
    <Badge variant={ok ? 'success' : 'warning'}>
      <Icon />
      {ok ? okLabel : failLabel}
    </Badge>
  );
}
