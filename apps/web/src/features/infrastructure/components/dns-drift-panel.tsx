import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { managedDomainQuery } from '@/features/infrastructure/api/queries';
import { DRIFT_KIND_LABELS, DRIFT_KIND_TONE } from '@/features/infrastructure/constants';
import { ToneBadge } from '@/features/settings/components/status-tone';
import { adoptDriftFinding, dismissDriftFinding } from '@/server/infrastructure-functions';
import type { DnsDriftFindingDto } from '@/server/infrastructure-functions';

/**
 * The desired-versus-observed diff, rendered directly from
 * `dns_drift_findings` — the design's own reason findings are a table rather
 * than a log. "Adopt" writes the observed value into `dns_records` as
 * `owner='manual'`; reality is never overwritten. The row itself clears on
 * the NEXT sync once desired and observed agree — see the server function's
 * doc for why that is the correct, already-tested behavior rather than an
 * optimistic resolve here.
 */
export default function DnsDriftPanel({
  domainId,
  domainName,
  findings
}: {
  domainId: string;
  domainName: string;
  findings: DnsDriftFindingDto[];
}) {
  const queryClient = useQueryClient();

  const adoptMutation = useMutation({
    mutationFn: (findingId: string) => adoptDriftFinding({ data: { domainId, findingId } }),
    onSuccess: async () => {
      toast.success('Adopted — the drift clears on the next sync');
      await queryClient.invalidateQueries({ queryKey: managedDomainQuery(domainName).queryKey });
    },
    onError: (error) => toastError(error, 'Failed to adopt this record')
  });

  const dismissMutation = useMutation({
    mutationFn: (findingId: string) => dismissDriftFinding({ data: { findingId } }),
    onSuccess: async () => {
      toast.success('Dismissed');
      await queryClient.invalidateQueries({ queryKey: managedDomainQuery(domainName).queryKey });
    },
    onError: (error) => toastError(error, 'Failed to dismiss this finding')
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>DNS drift</CardTitle>
        <CardDescription>Desired state versus what the provider actually has.</CardDescription>
      </CardHeader>
      <CardContent>
        {findings.length === 0 ? (
          <Empty className='p-0'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.circleCheck />
              </EmptyMedia>
              <EmptyTitle>No drift</EmptyTitle>
              <EmptyDescription>Desired and observed state agree.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className='flex flex-col gap-3'>
            {findings.map((finding) => (
              <li
                key={finding.id}
                className='flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between'
              >
                <div className='flex flex-col gap-1'>
                  <div className='flex items-center gap-2'>
                    <ToneBadge tone={DRIFT_KIND_TONE[finding.kind] ?? 'warning'}>
                      {DRIFT_KIND_LABELS[finding.kind] ?? finding.kind}
                    </ToneBadge>
                    <Badge variant='outline'>{finding.recordType}</Badge>
                    <span className='font-mono text-sm'>{finding.recordName}</span>
                  </div>
                  <div className='text-muted-foreground text-sm'>
                    {finding.desiredContent !== null && (
                      <div>Desired: {finding.desiredContent}</div>
                    )}
                    {finding.observedContent !== null && (
                      <div>Observed: {finding.observedContent}</div>
                    )}
                  </div>
                </div>
                <div className='flex shrink-0 gap-2'>
                  {finding.observedContent !== null && (
                    <Button
                      size='sm'
                      variant='outline'
                      disabled={adoptMutation.isPending}
                      onClick={() => adoptMutation.mutate(finding.id)}
                    >
                      Adopt
                    </Button>
                  )}
                  <Button
                    size='sm'
                    variant='ghost'
                    disabled={dismissMutation.isPending}
                    onClick={() => dismissMutation.mutate(finding.id)}
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
