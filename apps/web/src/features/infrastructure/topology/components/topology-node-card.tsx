import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Icons } from '@/components/icons';
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

/** Custom xyflow node renderer — a plain `bg-card`/`border` card, never a graph-specific palette (rule G5). */
export function TopologyNodeCard({ data }: NodeProps) {
  const { dto, dimmed, focused, onOpen } = data as unknown as TopologyNodeCardData;
  const tone = toneForStatus(dto.status);
  const statusLabel = dto.status === null ? 'No health data' : dto.status;

  return (
    <div
      className={cn(
        'w-64 rounded-lg border bg-card p-3 text-card-foreground shadow-sm transition-opacity',
        focused ? 'border-primary ring-primary/40 ring-2' : 'border-border',
        dimmed && 'opacity-35'
      )}
    >
      <Handle type='target' position={Position.Left} className='!bg-border !border-none' />
      <Handle type='source' position={Position.Right} className='!bg-border !border-none' />
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground text-xs'>{TOPOLOGY_NODE_KIND_LABELS[dto.kind]}</span>
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
          <span className='truncate'>{dto.name}</span>
          <Icons.externalLink className='size-3 shrink-0 text-muted-foreground' />
        </button>
      ) : (
        <p className='mt-1 truncate text-sm font-medium'>{dto.name}</p>
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
