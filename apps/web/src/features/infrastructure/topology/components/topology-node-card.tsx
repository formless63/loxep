import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Icons } from '@/components/icons';
import { BrandIcon } from '@/components/ui/brand-icon';
import { PROVIDER_BRAND_ICON_FALLBACKS, PROVIDER_BRAND_ICONS } from '@/config/provider-brand-icons';
import { integrationServiceForProvider } from '@/features/settings/integrations-catalog';
import { cn } from '@/lib/utils';
import { toneForStatus, TOPOLOGY_NODE_KIND_LABELS } from '../constants';
import type { Tone } from '@/features/settings/components/status-tone';
import type { TopologyNodeDto } from '@/server/infrastructure-topology-functions';

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

function StatusDot({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span
      className={cn('inline-block size-2 shrink-0 rounded-full', TONE_DOT_CLASS[tone])}
      title={label}
      aria-hidden={false}
      role='img'
      aria-label={label}
    />
  );
}

/** The data every `topology`-typed xyflow node carries (rule G5: token-themed card, `--primary` focus path, `--border` resting). */
export interface TopologyNodeCardData extends Record<string, unknown> {
  dto: TopologyNodeDto;
  dimmed: boolean;
  focused: boolean;
  onOpen: (dto: TopologyNodeDto) => void;
}

/**
 * `connection` nodes carry the raw provider slug in `dto.meta.provider`
 * (`infrastructure-topology-functions.ts`'s `meta: { provider: connection.
 * provider, ... }`) — the same registry lookup `/settings/connections`'
 * Provider column already does (`connections-table/columns.tsx`), so a
 * provider absent from the catalog (or a node kind that isn't `connection`)
 * renders no mark, exactly as that column falls through to no icon at all.
 */
function connectionBrandIcon(dto: TopologyNodeDto) {
  if (dto.kind !== 'connection') return null;
  const provider = dto.meta['provider'];
  if (provider === null || provider === undefined) return null;
  const service = integrationServiceForProvider(provider);
  if (service === null) return null;
  return (
    <BrandIcon
      mark={PROVIDER_BRAND_ICONS[service.id]}
      fallback={PROVIDER_BRAND_ICON_FALLBACKS[service.id]}
      name={service.name}
      size={16}
      className='text-muted-foreground'
    />
  );
}

/**
 * Rule G7's observed nodes carry the raw provider slug in `dto.meta.providerSlug`
 * (`infrastructure-topology-functions.ts`'s `observedResourceMeta` — the same
 * raw-slug convention `connectionBrandIcon` above already relies on for
 * `connection` nodes). Linked `tool` nodes don't carry this key yet (out of
 * this wave's scope), so they fall through to no mark, same as before.
 */
function observedResourceBrandIcon(dto: TopologyNodeDto) {
  if (!dto.observed) return null;
  const provider = dto.meta['providerSlug'];
  if (provider === null || provider === undefined) return null;
  const service = integrationServiceForProvider(provider);
  if (service === null) return null;
  return (
    <BrandIcon
      mark={PROVIDER_BRAND_ICONS[service.id]}
      fallback={PROVIDER_BRAND_ICON_FALLBACKS[service.id]}
      name={service.name}
      size={16}
      className='text-muted-foreground'
    />
  );
}

/** Custom xyflow node renderer — a plain `bg-card`/`border` card, never a graph-specific palette (rule G5). Rule G7's observed nodes render dashed/muted (`dto.observed`) — visually distinct, never a count badge (P15 stands; the "Observed" chip below is a state label, not a count). */
export function TopologyNodeCard({ data }: NodeProps) {
  const { dto, dimmed, focused, onOpen } = data as unknown as TopologyNodeCardData;
  const tone = toneForStatus(dto.status);
  const statusLabel = dto.status === null ? 'No health data' : dto.status;
  const brandIcon = connectionBrandIcon(dto) ?? observedResourceBrandIcon(dto);
  const providerUrl = dto.observed ? dto.meta['url'] : null;

  return (
    <div
      className={cn(
        'w-64 rounded-lg border p-3 text-card-foreground shadow-sm transition-opacity',
        dto.observed ? 'border-dashed bg-muted/40' : 'bg-card',
        focused
          ? 'border-primary ring-primary/40 ring-2'
          : dto.observed
            ? 'border-muted-foreground/40'
            : 'border-border',
        dimmed && 'opacity-35'
      )}
    >
      <Handle type='target' position={Position.Left} className='!bg-border !border-none' />
      <Handle type='source' position={Position.Right} className='!bg-border !border-none' />
      <div className='flex items-center justify-between gap-2'>
        <div className='flex min-w-0 items-center gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {TOPOLOGY_NODE_KIND_LABELS[dto.kind]}
          </span>
          {dto.observed && (
            <span className='rounded border border-dashed border-muted-foreground/50 px-1 py-0 text-[9px] text-muted-foreground'>
              Observed
            </span>
          )}
        </div>
        <StatusDot tone={tone} label={statusLabel} />
      </div>
      {dto.href ? (
        <button
          type='button'
          onClick={(event) => {
            event.stopPropagation();
            onOpen(dto);
          }}
          className='mt-1 flex w-full items-center gap-1 truncate text-left text-sm font-medium hover:text-primary hover:underline focus-visible:ring-primary focus-visible:ring-2 focus-visible:outline-none'
        >
          {brandIcon}
          <span className='truncate'>{dto.name}</span>
          <Icons.externalLink className='size-3 shrink-0 text-muted-foreground' />
        </button>
      ) : (
        <p className='mt-1 flex items-center gap-1 truncate text-sm font-medium'>
          {brandIcon}
          {dto.name}
        </p>
      )}
      {providerUrl && (
        <a
          href={providerUrl}
          target='_blank'
          rel='noreferrer'
          onClick={(event) => event.stopPropagation()}
          className='mt-1 flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-primary hover:underline'
        >
          <Icons.externalLink className='size-3 shrink-0' />
          Open at provider
        </a>
      )}
      {dto.badges.length > 0 && (
        <div className='mt-2 flex flex-wrap gap-1'>
          {dto.badges.map((badge) => (
            <span
              key={badge}
              className='rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground'
            >
              {badge}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
