import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

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

/** Boolean status pill used across the market tables. */
export function StatusBadge({
  ok,
  okLabel,
  failLabel
}: {
  ok: boolean;
  okLabel: string;
  failLabel: string;
}) {
  return <Badge variant={ok ? 'secondary' : 'destructive'}>{ok ? okLabel : failLabel}</Badge>;
}
