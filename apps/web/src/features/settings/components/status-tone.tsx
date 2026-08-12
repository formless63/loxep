import type { ReactNode } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { Badge, type badgeVariants } from '@/components/ui/badge';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';

/** Every tone a settings badge can render — mirrors `Badge`'s own variants. */
export type Tone = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

const TONE_ICON: Record<Tone, (typeof Icons)['circleCheck']> = {
  default: Icons.circleCheck,
  secondary: Icons.circle,
  destructive: Icons.xCircle,
  success: Icons.circleCheck,
  warning: Icons.warning,
  outline: Icons.circle,
  ghost: Icons.circle,
  link: Icons.circle
};

/** Tone-mapped badge, icon included so meaning never rides on hue alone. */
export function ToneBadge({
  tone,
  className,
  children,
  title
}: {
  tone: Tone;
  className?: string;
  children: ReactNode;
  /** Native tooltip — for a badge whose tone/label alone doesn't explain itself. */
  title?: string;
}) {
  const Icon = TONE_ICON[tone];
  return (
    <Badge variant={tone} className={cn('capitalize', className)} title={title}>
      <Icon />
      {children}
    </Badge>
  );
}

/**
 * Boolean state badge with a tone per branch — replaces the old
 * `ok ? 'secondary' : 'destructive'` `StatusBadge`, which rendered every
 * "off" state (an operator-disabled endpoint, a deactivated entity) with the
 * same alarm red as a genuine failure. Callers choose the "off" tone for
 * their domain: `warning` for an operator-caused disabled state, `outline`
 * for a neutral terminal state (a deactivated entity), `destructive` only
 * where "off" really is a failure (a health check).
 */
export function BooleanStatusBadge({
  value,
  trueLabel,
  falseLabel,
  trueTone = 'success',
  falseTone = 'destructive'
}: {
  value: boolean;
  trueLabel: string;
  falseLabel: string;
  trueTone?: Tone;
  falseTone?: Tone;
}) {
  return (
    <ToneBadge tone={value ? trueTone : falseTone}>{value ? trueLabel : falseLabel}</ToneBadge>
  );
}
