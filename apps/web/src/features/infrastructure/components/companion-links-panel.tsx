import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDateTime, formatRelativeTime } from '@/lib/format';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import { hostingTargetQuery } from '@/features/infrastructure/api/queries';
import AddCompanionLinkDialog from '@/features/infrastructure/components/add-companion-link-dialog';
import { removeCompanionLink } from '@/server/infrastructure-functions';
import type { CompanionLinkDto, CompanionLinkHealthDto } from '@/server/infrastructure-functions';
// Type-only — erased at compile time, so this carries no runtime import of
// `@loxep/domain` (which pulls in server-only packages) into the client
// bundle. Same discipline `infrastructure-functions.ts` follows for its own
// top-level server-package imports.
import type { HostDiagnosisResult } from '@loxep/domain';

/** Design's closed status set — mirrors `integration-health-report/columns.tsx`'s map (one per feature, no cross-feature import). */
const STATUS_TONE: Record<CompanionLinkHealthDto['status'], Tone> = {
  ok: 'success',
  degraded: 'warning',
  failing: 'destructive',
  unknown: 'outline'
};

/**
 * A short, accurate caption for `detail.kind` — every status renders its
 * provenance, per the design's "Where this surfaces" rule ("a status with
 * no visible age [or explanation] is a status an operator will over-trust").
 * Reads `detail` generically by shape, mirroring
 * `integration-health-report/columns.tsx`'s `authFailureHint`.
 */
function healthDetailHint(detail: Record<string, unknown> | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const kind = detail['kind'];
  if (kind === 'unreachable') {
    return 'Loxep could not reach this tool — it may sit behind a tunnel or a private network Loxep is not on.';
  }
  if (kind === 'http_error') {
    const statusCode = detail['statusCode'];
    return typeof statusCode === 'number'
      ? `The tool's health path answered with HTTP ${statusCode}.`
      : "The tool's health path returned an error response.";
  }
  if (kind === 'no_health_path') {
    return 'This tool publishes no unauthenticated health path Loxep can check automatically.';
  }
  if (kind === 'invalid_url') {
    return "This link's stored URL could not be parsed.";
  }
  return undefined;
}

/**
 * One companion link's health cell: status/source/age, or an honest "no
 * automated check" when `health` is `null` — never a fabricated `unknown`
 * badge for a link the sweep has not reached (or cannot reach at all; see
 * `@loxep/domain`'s `fleet-tool-registry.ts`).
 */
function LinkHealth({ health }: { health: CompanionLinkHealthDto | null }) {
  if (health === null) {
    return <span className='text-muted-foreground text-sm'>No automated check yet</span>;
  }
  const hint = healthDetailHint(health.detail);
  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <ToneBadge tone={STATUS_TONE[health.status]} title={hint}>
          {health.status}
        </ToneBadge>
        <span className='text-muted-foreground text-xs'>{health.source}</span>
      </div>
      <span className='text-muted-foreground text-xs' title={formatDateTime(health.checkedAt)}>
        Loxep checked {formatRelativeTime(health.checkedAt)}
        {/* This tool reports no observation time of its own today — the
            tier-2 probe is a credential-free reachability ping, so there is
            only ONE clock to render. Said explicitly rather than silently
            implying a second, tool-reported clock exists (the design's
            two-clock rule, applied to its "reports none" branch). */}
        {hint !== undefined && ` · ${hint}`}
      </span>
    </div>
  );
}

function RemoveLinkButton({
  link,
  hostingTargetName
}: {
  link: CompanionLinkDto;
  hostingTargetName: string;
}) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      removeCompanionLink({
        data: {
          externalResourceId: link.id,
          hostingTargetId: link.resourceId,
          purpose: link.purpose
        }
      }),
    onSuccess: async () => {
      toast.success('Companion link removed');
      await queryClient.invalidateQueries({
        queryKey: hostingTargetQuery(hostingTargetName).queryKey
      });
    },
    onError: (error) => toastError(error, 'Failed to remove companion link')
  });

  return (
    <Button
      size='icon'
      variant='ghost'
      className='text-muted-foreground hover:text-destructive'
      disabled={mutation.isPending}
      onClick={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
      aria-label={`Remove ${link.title ?? link.provider} link`}
    >
      <Icons.trash />
    </Button>
  );
}

/**
 * `diagnoseHostWitnesses`'s one derived sentence (loxep-50t §3.1, loxep-1au
 * §5, loxep-y64 §4), rendered above the link list. NEVER a second sentence
 * function — this renders `result.sentence` verbatim, including the
 * mandatory "Not enough linked tools to say." refusal, and carries no tone
 * derived from `result.reason` (witness-not-verdict: a colored alert here
 * would itself be the aggregate verdict chip the design forbids). Absent
 * entirely when there are no ladder witnesses at all — an empty panel
 * already says "nothing configured" on its own; a refusal sentence over
 * zero links would be redundant noise, not honesty.
 */
function HostDiagnosisSentence({ diagnosis }: { diagnosis: HostDiagnosisResult }) {
  if (diagnosis.witnesses.length === 0) return null;
  return (
    <Alert>
      <Icons.info />
      <AlertTitle>Diagnosis</AlertTitle>
      <AlertDescription>{diagnosis.sentence}</AlertDescription>
    </Alert>
  );
}

/**
 * `external_resources`/`resource_links` for this hosting target, via
 * `@loxep/domain`'s generic companion-link service (loxep-v5r.3), upgraded
 * by loxep-ovj.3 to project each link's `integration_health` status/source/
 * age. Loxep LINKS companion tooling (metrics, uptime, container
 * management) — it never reimplements it. "Add tool link" writes a deep
 * link only; no credential, no adapter, no vendor cooperation.
 *
 * Render order is `fetchHostingTarget`'s (server-side, via
 * `compareFleetToolPanelOrder`) — this component does not re-sort.
 */
export default function CompanionLinksPanel({
  hostingTargetId,
  hostingTargetName,
  links,
  diagnosis
}: {
  hostingTargetId: string;
  hostingTargetName: string;
  links: CompanionLinkDto[];
  diagnosis: HostDiagnosisResult;
}) {
  const [addOpen, setAddOpen] = React.useState(false);

  const addButton = (
    <Button size='sm' onClick={() => setAddOpen(true)}>
      <Icons.add />
      Add tool link
    </Button>
  );

  return (
    <div className='flex flex-col gap-3'>
      <HostDiagnosisSentence diagnosis={diagnosis} />
      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Companion tools</CardTitle>
          <CardDescription>
            Metrics, uptime, and container management — linked, never reimplemented.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {links.length === 0 ? (
            <Empty className='p-0'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <Icons.externalLink />
                </EmptyMedia>
                <EmptyTitle>No companion tool linked yet</EmptyTitle>
                <EmptyDescription>
                  Nothing here links a monitoring or management dashboard to this host.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>{addButton}</EmptyContent>
            </Empty>
          ) : (
            <div className='flex flex-col gap-3'>
              <ul className='flex flex-col gap-2'>
                {links.map((link) => (
                  <li
                    key={`${link.id}-${link.purpose}`}
                    className='flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2'
                  >
                    <a
                      href={link.url}
                      target='_blank'
                      rel='noreferrer'
                      className='flex min-w-0 flex-1 flex-col outline-none focus-visible:ring-[3px] focus-visible:ring-ring'
                    >
                      <span className='flex items-center gap-2'>
                        <span className='font-medium'>
                          {link.title ?? link.knownTool?.label ?? link.provider}
                        </span>
                        <Icons.externalLink className='text-muted-foreground size-3.5 shrink-0' />
                      </span>
                      <span className='text-muted-foreground text-sm'>
                        {link.knownTool?.label ?? link.provider} · {link.externalType} ·{' '}
                        {link.purpose} · linked {formatDateTime(link.createdAt)}
                      </span>
                    </a>
                    <div className='flex items-center gap-2'>
                      <LinkHealth health={link.health} />
                      <RemoveLinkButton link={link} hostingTargetName={hostingTargetName} />
                    </div>
                  </li>
                ))}
              </ul>
              <div>{addButton}</div>
            </div>
          )}
        </CardContent>
      </Card>
      {addOpen && (
        <AddCompanionLinkDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          hostingTargetId={hostingTargetId}
          hostingTargetName={hostingTargetName}
        />
      )}
    </div>
  );
}
