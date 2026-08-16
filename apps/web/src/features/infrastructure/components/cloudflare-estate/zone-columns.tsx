import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { CloudflareEstateZoneDto } from '@/server/cloudflare-estate-functions';

/**
 * Cloudflare's own zone status, VERBATIM (Rule P3) — `initializing` /
 * `pending` / `active` / `moved` per the adapter's module doc. Only `active`
 * is ever branched on anywhere in this codebase; every other value renders
 * through the neutral `outline` tone rather than being second-guessed.
 */
const ZONE_STATUS_TONE: Record<string, 'success' | 'outline'> = {
  active: 'success'
};

export function cloudflareZoneColumns(
  onViewRecords: (zone: CloudflareEstateZoneDto) => void,
  selectedZoneId: string | null
): ColumnDef<DataTableFeatures, CloudflareEstateZoneDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, CloudflareEstateZoneDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Zone' />,
      cell: ({ row }) => <span className='font-mono font-medium'>{row.original.name}</span>,
      meta: {
        label: 'Zone',
        placeholder: 'Search zones...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'status',
      accessorKey: 'status',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, CloudflareEstateZoneDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Status' />,
      cell: ({ row }) => (
        <div className='flex items-center gap-1.5'>
          <ToneBadge tone={ZONE_STATUS_TONE[row.original.status] ?? 'outline'}>
            {row.original.status}
          </ToneBadge>
          {row.original.paused && <Badge variant='secondary'>paused</Badge>}
        </div>
      )
    },
    {
      id: 'nameservers',
      header: 'Name servers',
      cell: ({ row }) =>
        row.original.nameservers.length === 0 ? (
          <span className='text-muted-foreground'>—</span>
        ) : (
          <span className='text-muted-foreground font-mono text-xs'>
            {row.original.nameservers.join(', ')}
          </span>
        )
    },
    {
      id: 'managed',
      header: 'Managed by Loxep',
      cell: ({ row }) => {
        const managed = row.original.managedDomain;
        if (managed === null) {
          return <Badge variant='secondary'>Not declared</Badge>;
        }
        return (
          <Button size='sm' variant='link' className='h-auto p-0' asChild>
            <Link to='/infrastructure/domains/$name' params={{ name: managed.name }}>
              <Icons.circleCheck className='mr-1 h-3.5 w-3.5' /> Managed by Loxep
            </Link>
          </Button>
        );
      }
    },
    {
      id: 'records',
      header: 'Records',
      cell: ({ row }) => {
        const isOpen = selectedZoneId === row.original.externalZoneId;
        return (
          <Button
            size='sm'
            variant={isOpen ? 'default' : 'outline'}
            onClick={() => onViewRecords(row.original)}
          >
            {isOpen ? 'Hide records' : 'View records'}
          </Button>
        );
      }
    }
  ];
}
