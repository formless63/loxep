import { Icons } from '@/components/icons';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { TOPOLOGY_NODE_KIND_LABELS } from '../constants';
import type { TopologyNodeKind } from '@/server/infrastructure-topology-functions';
import { TOPOLOGY_NODE_KINDS } from '@/server/infrastructure-topology-functions';

/**
 * Rule G6's filter chips + text filter. Chips wrap on their own (`flex-wrap`)
 * — no structural change at 768px is needed beyond that (the mobile note's
 * "filter chips wrap" requirement).
 */
export function TopologyFilters({
  activeKinds,
  onToggleKind,
  textFilter,
  onTextFilterChange
}: {
  activeKinds: ReadonlySet<TopologyNodeKind>;
  onToggleKind: (kind: TopologyNodeKind) => void;
  textFilter: string;
  onTextFilterChange: (value: string) => void;
}) {
  return (
    <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
      <div className='flex flex-wrap gap-2'>
        {TOPOLOGY_NODE_KINDS.map((kind) => (
          <Toggle
            key={kind}
            size='sm'
            variant='outline'
            pressed={activeKinds.has(kind)}
            onPressedChange={() => onToggleKind(kind)}
            aria-label={`Toggle ${TOPOLOGY_NODE_KIND_LABELS[kind]} nodes`}
          >
            {TOPOLOGY_NODE_KIND_LABELS[kind]}
          </Toggle>
        ))}
      </div>
      <div className='relative w-full sm:w-64'>
        <Icons.search className='pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground' />
        <Input
          value={textFilter}
          onChange={(event) => onTextFilterChange(event.target.value)}
          placeholder='Filter by name…'
          className='pl-8'
          aria-label='Filter topology nodes by name'
        />
      </div>
    </div>
  );
}
