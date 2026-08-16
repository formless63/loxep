import type { ReactNode } from 'react';

/**
 * The estate-browser shell's ONE shared page frame (loxep-47o.1, Rule P1 —
 * "one shared page component"). Deliberately workspace-agnostic (no import
 * from any `features/<workspace>` module) so a future `/finance/estate`
 * route can use it exactly as `/infrastructure/estate` does — matching
 * `InfrastructurePage`'s own visual shape (title, description, optional
 * actions) without depending on it, since that component is scoped to the
 * infrastructure workspace only.
 */
export function EstatePage({
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
