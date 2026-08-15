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
import AttachDiscoveredResourceDialog from '@/features/infrastructure/components/attach-discovered-resource-dialog';
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

/** `detail.status`/`detail.observedAt`, read generically — the shape any adapter-sourced per-resource health row carries (loxep-y64 §1 for Beszel; the same two fields any future provider's discovery slice writes). */
function detailStringField(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === 'string' ? value : null;
}

function detailNumberField(detail: Record<string, unknown>, key: string): number | null {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Termix's access-affordance chip (loxep-wvm §3/§4.4): the best-effort
 * active-session COUNT, read straight off this link's own `detail.
 * sessionCount` (written by `projectTermixResources`, present only for
 * LINKED hosts). Absent when the enrichment read failed or has not run yet
 * — never a fabricated zero. A count, never a name — sharedByUsername-style
 * per-session data is out of scope permanently (wvm §3.3(a)). Termix earns
 * NO dedicated panel (wvm §4.4) — this is the one row the anti-soup rule
 * allows, right here in the shared list, with the deep link already
 * carried by the row's own `<a href>`.
 */
function TermixSessionCountChip({ link }: { link: CompanionLinkDto }) {
  if (link.provider !== 'termix' || link.health === null) return null;
  const count = detailNumberField(link.health.detail, 'sessionCount');
  if (count === null) return null;
  return (
    <span className='text-muted-foreground text-xs' title='Active terminal sessions, per Termix'>
      {count} active {count === 1 ? 'session' : 'sessions'}
    </span>
  );
}

/**
 * One companion link's health cell: status/source/age, or an honest "no
 * automated check" when `health` is `null` — never a fabricated `unknown`
 * badge for a link the sweep has not reached (or cannot reach at all; see
 * `@loxep/domain`'s `fleet-tool-registry.ts`).
 *
 * **The verbatim chip + two clocks (loxep-y64 §3).** An `adapter`-sourced
 * row (today: an attached Beszel system) carries the tool's own status
 * STRING in `detail.status` — rendered verbatim in the badge, never
 * translated through Loxep's coarser ok/degraded/failing/unknown label,
 * which still only decides the badge's TONE. When `detail.observedAt` is
 * also present, two distinct clocks render: the tool's own reported instant
 * and Loxep's read clock, named separately per the design's rule ("Beszel
 * updated 40s ago, read by Loxep 3 min ago"). A `probe`-sourced row (the
 * generic credential-free tier-2 reachability check) has no tool-reported
 * timestamp at all — it keeps the single "Loxep checked" clock exactly as
 * before this slice.
 */
function LinkHealth({ link }: { link: CompanionLinkDto }) {
  const health = link.health;
  if (health === null) {
    return <span className='text-muted-foreground text-sm'>No automated check yet</span>;
  }
  const hint = healthDetailHint(health.detail);
  const label = link.knownTool?.label ?? link.provider;
  const verbatimStatus = detailStringField(health.detail, 'status');
  const observedAt = detailStringField(health.detail, 'observedAt');

  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex flex-wrap items-center gap-1.5'>
        <ToneBadge tone={STATUS_TONE[health.status]} title={hint}>
          {verbatimStatus ?? health.status}
        </ToneBadge>
        <span className='text-muted-foreground text-xs'>{health.source}</span>
      </div>
      <span className='text-muted-foreground text-xs' title={formatDateTime(health.checkedAt)}>
        {health.source === 'adapter' && observedAt !== null ? (
          <>
            {label} updated {formatRelativeTime(observedAt)} · Loxep read{' '}
            {formatRelativeTime(health.checkedAt)}
          </>
        ) : health.source === 'adapter' ? (
          <>
            {label} reported no timestamp · Loxep read {formatRelativeTime(health.checkedAt)}
          </>
        ) : (
          <>
            {/* This tool reports no observation time of its own today — the
                tier-2 probe is a credential-free reachability ping, so there
                is only ONE clock to render. Said explicitly rather than
                silently implying a second, tool-reported clock exists (the
                design's two-clock rule, applied to its "reports none"
                branch). */}
            Loxep checked {formatRelativeTime(health.checkedAt)}
          </>
        )}
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
 * Every provider with a shipped discovery writer (`@loxep/app`'s
 * `project<Provider>*` functions) that the operator-confirmed attach picker
 * (loxep-y64 slice 3) can offer — reusing the SAME generic
 * `AttachDiscoveredResourceDialog` component with a different `provider`/
 * `providerLabel`, per that dialog's own doc. Beszel shipped first
 * (loxep-y64); Tailscale (loxep-50t slice B), Gatus (loxep-1au slice B),
 * Dockhand (loxep-hb7 Milestone B) and Termix (loxep-wvm Slice B) add their
 * own entries here in the same shape — nothing else in this component needs
 * to change per provider.
 */
const ATTACHABLE_DISCOVERY_PROVIDERS: readonly { provider: string; label: string; noun: string }[] =
  [
    { provider: 'beszel', label: 'Beszel', noun: 'system' },
    { provider: 'tailscale', label: 'Tailscale', noun: 'device' },
    { provider: 'gatus', label: 'Gatus', noun: 'endpoint' },
    { provider: 'dockhand', label: 'Dockhand', noun: 'environment' },
    { provider: 'termix', label: 'Termix', noun: 'host' }
  ];

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
  // Which discovered-resource provider's attach dialog is open, if any — at
  // most one at a time, mirroring `addOpen`'s single-dialog shape.
  const [attachProvider, setAttachProvider] = React.useState<string | null>(null);

  const addButton = (
    <Button size='sm' onClick={() => setAddOpen(true)}>
      <Icons.add />
      Add tool link
    </Button>
  );

  // loxep-y64 slice 3: the operator-confirmed attach picker over a
  // provider's discovered-but-unlinked resources. A SEPARATE action from
  // "Add tool link" on purpose — that form writes an operator-typed URL with
  // no credential behind it; these confirm one of Loxep's own discovery-swept
  // `external_resources` rows, never a hand-typed one.
  const attachButtons = ATTACHABLE_DISCOVERY_PROVIDERS.map(({ provider, label, noun }) => (
    <Button key={provider} size='sm' variant='outline' onClick={() => setAttachProvider(provider)}>
      <Icons.radar />
      Attach discovered {label} {noun}
    </Button>
  ));

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
              <EmptyContent>
                <div className='flex flex-wrap justify-center gap-2'>
                  {addButton}
                  {attachButtons}
                </div>
              </EmptyContent>
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
                      <TermixSessionCountChip link={link} />
                      <LinkHealth link={link} />
                      <RemoveLinkButton link={link} hostingTargetName={hostingTargetName} />
                    </div>
                  </li>
                ))}
              </ul>
              <div className='flex flex-wrap gap-2'>
                {addButton}
                {attachButtons}
              </div>
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
      {attachProvider !== null && (
        <AttachDiscoveredResourceDialog
          open={attachProvider !== null}
          onOpenChange={(open) => setAttachProvider(open ? attachProvider : null)}
          hostingTargetId={hostingTargetId}
          hostingTargetName={hostingTargetName}
          provider={attachProvider}
          providerLabel={
            ATTACHABLE_DISCOVERY_PROVIDERS.find((entry) => entry.provider === attachProvider)
              ?.label ?? attachProvider
          }
        />
      )}
    </div>
  );
}
