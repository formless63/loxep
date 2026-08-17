import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { BrandIcon } from '@/components/ui/brand-icon';
import { Icons } from '@/components/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { PROVIDER_BRAND_ICONS } from '@/config/provider-brand-icons';
import { cn } from '@/lib/utils';
import {
  MANAGED_DOMAIN_STATE_LABELS,
  MANAGED_DOMAIN_STATE_TONE,
  RUN_STATUS_TONE
} from '@/features/infrastructure/constants';
import type { Tone } from '@/features/settings/components/status-tone';
import type { DnsRecordDto, ManagedDomainDetailDto } from '@/server/infrastructure-functions';

/**
 * Fixed 4-element chain (loxep-0g4 D4): domain -> apex/proxy DNS record ->
 * Pangolin resource -> hosting target. Every field is already on
 * `ManagedDomainDetailDto` (the ONE query `/infrastructure/domains/$name`
 * makes, via `managedDomainQuery`) — this component reads only props, it
 * never fetches. Not `@xyflow` (that's for the topology canvas
 * `topology-node-card.tsx` renders); this is a fixed-cardinality row, so a
 * flex row of token-styled chips is the honest fit, per the design brief.
 */

const TONE_DOT_CLASS: Record<Tone, string> = {
  default: 'bg-primary',
  secondary: 'bg-secondary',
  destructive: 'bg-destructive',
  success: 'bg-success',
  warning: 'bg-warning',
  outline: 'bg-muted-foreground/40',
  ghost: 'bg-muted-foreground/40',
  link: 'bg-muted-foreground/40'
};

function ChainDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE_DOT_CLASS[tone])}
      role='img'
      aria-label={label}
      title={label}
    />
  );
}

function ChainArrow() {
  return <Icons.arrowRight className='text-muted-foreground size-4 shrink-0' aria-hidden />;
}

const CHIP_CLASS = 'flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-sm';
const CHIP_LINK_CLASS = cn(
  CHIP_CLASS,
  'outline-none transition-colors hover:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring'
);
const CHIP_PLACEHOLDER_CLASS =
  'text-muted-foreground flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-sm';

/** A declared chain element: an icon, a name, and an optional status dot — plain text, or a deep link when the caller passes `to`/`params`. */
function ChainChip({
  icon,
  name,
  tone,
  to,
  params
}: {
  icon: React.ReactNode;
  name: string;
  tone?: { value: Tone; label: string };
  to?: '/infrastructure/estate/$connectionId' | '/infrastructure/fleet/$name';
  params?: Record<string, string>;
}) {
  const content = (
    <>
      {icon}
      <span className='max-w-40 truncate font-medium'>{name}</span>
      {tone && <ChainDot tone={tone.value} label={tone.label} />}
    </>
  );
  if (to === '/infrastructure/estate/$connectionId' && params) {
    return (
      <Link
        to={to}
        params={{ connectionId: params.connectionId ?? '' }}
        className={CHIP_LINK_CLASS}
      >
        {content}
      </Link>
    );
  }
  if (to === '/infrastructure/fleet/$name' && params) {
    return (
      <Link to={to} params={{ name: params.name ?? '' }} className={CHIP_LINK_CLASS}>
        {content}
      </Link>
    );
  }
  return <div className={CHIP_CLASS}>{content}</div>;
}

/** A missing chain element — calm P3b language ("not declared"), never an alarm. */
function ChainPlaceholder({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className={CHIP_PLACEHOLDER_CLASS}>
      {icon}
      <span>{text}</span>
    </div>
  );
}

/** Prefers the record a Pangolin resource actually owns; falls back to the plain apex record when the domain is DNS-only. Mirrors `dns_records.owner`'s closed set (`@loxep/db/schema/infrastructure.ts`'s `DNS_RECORD_OWNERS`). */
function pickFrontingRecord(records: DnsRecordDto[]): DnsRecordDto | null {
  return (
    records.find((r) => r.owner === 'proxy_resource') ??
    records.find((r) => r.owner === 'apex') ??
    null
  );
}

export default function DomainChainDiagram({ domain }: { domain: ManagedDomainDetailDto }) {
  const record = pickFrontingRecord(domain.records);
  const recordDrifted =
    record !== null && domain.unresolvedDrift.some((finding) => finding.recordName === record.name);

  const resource =
    domain.proxyResources.find((entry) => entry.subdomain === null) ??
    domain.proxyResources[0] ??
    null;
  const resourceTone: { value: Tone; label: string } | undefined =
    resource === null
      ? undefined
      : !resource.enabled
        ? { value: 'warning', label: 'Disabled' }
        : resource.lastRun === null
          ? { value: 'secondary', label: 'Not yet checked' }
          : {
              value: RUN_STATUS_TONE[resource.lastRun.status] ?? 'secondary',
              label: resource.lastRun.status
            };

  const hostingTargetName = resource?.hostingTargetName ?? domain.apexTargetName ?? null;

  const cloudflareIcon = (
    <BrandIcon
      mark={PROVIDER_BRAND_ICONS.cloudflare}
      name='Cloudflare'
      size={16}
      className='shrink-0'
    />
  );
  const pangolinIcon = (
    <BrandIcon
      mark={PROVIDER_BRAND_ICONS.pangolin}
      name='Pangolin'
      size={16}
      className='shrink-0'
    />
  );
  const worldIcon = <Icons.world className='text-muted-foreground size-4 shrink-0' aria-hidden />;
  const serverIcon = <Icons.server className='text-muted-foreground size-4 shrink-0' aria-hidden />;

  return (
    <div className='flex flex-wrap items-center gap-2' role='group' aria-label='Provisioning chain'>
      <ChainChip
        icon={worldIcon}
        name={domain.name}
        tone={{
          value: MANAGED_DOMAIN_STATE_TONE[domain.state] ?? 'secondary',
          label: MANAGED_DOMAIN_STATE_LABELS[domain.state] ?? domain.state
        }}
      />
      <ChainArrow />
      {record === null ? (
        <ChainPlaceholder icon={cloudflareIcon} text='DNS record not yet declared' />
      ) : (
        <ChainChip
          icon={cloudflareIcon}
          name={record.name}
          tone={
            recordDrifted
              ? { value: 'warning', label: 'Drift detected' }
              : { value: 'success', label: 'In sync' }
          }
          to='/infrastructure/estate/$connectionId'
          params={{ connectionId: domain.dnsConnectionId }}
        />
      )}
      <ChainArrow />
      {resource === null ? (
        <ChainPlaceholder icon={pangolinIcon} text='Pangolin resource not yet declared' />
      ) : (
        <ChainChip
          icon={pangolinIcon}
          name={resource.fullDomain}
          {...(resourceTone && { tone: resourceTone })}
          {...(resource.connectionId && {
            to: '/infrastructure/estate/$connectionId' as const,
            params: { connectionId: resource.connectionId }
          })}
        />
      )}
      <ChainArrow />
      {hostingTargetName === null ? (
        <ChainPlaceholder icon={serverIcon} text='hosting target not yet declared' />
      ) : (
        // No status dot: this page's data carries no live health signal for
        // the hosting target itself (that lives on
        // /infrastructure/fleet/$name, which this deep link already reaches)
        // — an honest omission rather than a fabricated tone.
        <ChainChip
          icon={serverIcon}
          name={hostingTargetName}
          to='/infrastructure/fleet/$name'
          params={{ name: hostingTargetName }}
        />
      )}
    </div>
  );
}

/** Skeleton sibling matching `$name.tsx`'s `DetailSkeleton` treatment (single Suspense boundary — one query backs the whole page). */
export function DomainChainDiagramSkeleton() {
  return <Skeleton className='h-10 w-full max-w-2xl' />;
}
