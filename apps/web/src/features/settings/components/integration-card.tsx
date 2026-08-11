import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type {
  IntegrationStatus,
  IntegrationStatusTone
} from '@/features/settings/integrations-catalog';

const STATUS_VARIANT: Record<IntegrationStatusTone, 'secondary' | 'outline' | 'destructive'> = {
  ready: 'secondary',
  partial: 'destructive',
  unconfigured: 'outline'
};

/** Status pill plus the service's supporting facts (never credential material). */
export function IntegrationStatusBadges({ status }: { status: IntegrationStatus }) {
  return (
    <div className='flex flex-wrap items-center gap-2 text-sm'>
      <Badge variant={STATUS_VARIANT[status.tone]}>{status.label}</Badge>
      {status.details.map((detail) => (
        <Badge key={detail} variant='outline'>
          {detail}
        </Badge>
      ))}
    </div>
  );
}

/**
 * One catalog card: what the service is, how far its set-up has got, and the
 * single action that takes an operator to the rest of it. Every card on
 * `/settings/integrations` is this shell so the catalog reads as one surface.
 */
export function IntegrationCard({
  name,
  description,
  status,
  isPending,
  action,
  children
}: {
  name: string;
  description: string;
  status: IntegrationStatus;
  isPending?: boolean;
  action: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Card className='flex h-full flex-col'>
      <CardHeader className='flex flex-row items-start justify-between gap-4'>
        <div className='min-w-0'>
          <CardTitle className='text-base'>{name}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
        <div className='shrink-0'>{action}</div>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col justify-end gap-3'>
        {isPending === true ? (
          <Skeleton className='h-6 w-48' />
        ) : (
          <IntegrationStatusBadges status={status} />
        )}
        {children}
      </CardContent>
    </Card>
  );
}
