import type { ReactNode } from 'react';

/** Shared page frame for finance surfaces: heading, blurb, optional actions. */
export function FinancePage({
  title,
  description,
  actions,
  children
}: {
  title: string;
  /** Omit on dense working surfaces (owner directive 2026-08-18: subtitles cost a row the content wants). */
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className='flex flex-1 flex-col gap-4 p-4 pt-0'>
      <div className='flex flex-wrap items-start justify-between gap-2'>
        <div>
          <h1 className='text-xl font-semibold tracking-tight'>{title}</h1>
          {description && <p className='text-muted-foreground text-sm'>{description}</p>}
        </div>
        {actions && <div className='flex items-center gap-2'>{actions}</div>}
      </div>
      {children}
    </div>
  );
}
