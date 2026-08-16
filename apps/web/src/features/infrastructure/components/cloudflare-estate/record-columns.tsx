import type { Column, ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge, type Tone } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type {
  CloudflareEstateRecordCrossReference,
  CloudflareEstateRecordDto
} from '@/server/cloudflare-estate-functions';

/**
 * The cross-reference against Loxep's OWN `dns_records`/`dns_drift_findings`
 * (Estate Browsers Design §3.1) — never a re-labelling of Cloudflare's own
 * facts (Rule P3), a SEPARATE column entirely.
 */
const CROSS_REFERENCE_LABEL: Record<CloudflareEstateRecordCrossReference, string> = {
  declared: 'Declared',
  drift_open: 'Drift finding open',
  unexpected: 'Unexpected'
};

const CROSS_REFERENCE_TONE: Record<CloudflareEstateRecordCrossReference, Tone> = {
  declared: 'success',
  drift_open: 'warning',
  unexpected: 'secondary'
};

export function cloudflareRecordColumns(
  onAdopt: (record: CloudflareEstateRecordDto) => void,
  canAdopt: boolean
): ColumnDef<DataTableFeatures, CloudflareEstateRecordDto>[] {
  return [
    {
      id: 'type',
      accessorKey: 'type',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, CloudflareEstateRecordDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Type' />,
      cell: ({ row }) => <Badge variant='outline'>{row.original.type}</Badge>,
      enableColumnFilter: true,
      meta: { label: 'Type', variant: 'multiSelect' as const }
    },
    {
      id: 'fqdn',
      accessorKey: 'fqdn',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, CloudflareEstateRecordDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Name' />,
      cell: ({ row }) => <span className='font-mono text-sm'>{row.original.fqdn}</span>,
      meta: {
        label: 'Name',
        placeholder: 'Search records...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'content',
      header: 'Content',
      cell: ({ row }) => (
        <span
          className='text-muted-foreground max-w-xs truncate font-mono text-xs'
          title={row.original.content}
        >
          {row.original.content}
        </span>
      )
    },
    {
      id: 'ttl',
      header: 'TTL',
      cell: ({ row }) => (
        <span className='text-muted-foreground text-sm'>
          {row.original.ttlSeconds === null ? 'automatic' : `${row.original.ttlSeconds}s`}
        </span>
      )
    },
    {
      id: 'proxied',
      header: 'Proxied',
      cell: ({ row }) => {
        if (!row.original.proxiable) {
          return <span className='text-muted-foreground text-sm'>not proxiable</span>;
        }
        return row.original.proxied ? (
          <ToneBadge tone='success'>proxied</ToneBadge>
        ) : (
          <Badge variant='outline'>DNS only</Badge>
        );
      }
    },
    {
      id: 'crossReference',
      accessorKey: 'crossReference',
      header: 'Loxep state',
      cell: ({ row }) => (
        <ToneBadge tone={CROSS_REFERENCE_TONE[row.original.crossReference]}>
          {CROSS_REFERENCE_LABEL[row.original.crossReference]}
        </ToneBadge>
      ),
      enableColumnFilter: true,
      meta: {
        label: 'Loxep state',
        variant: 'multiSelect' as const,
        options: Object.entries(CROSS_REFERENCE_LABEL).map(([value, label]) => ({ value, label }))
      }
    },
    {
      id: 'adopt',
      header: 'Adopt',
      cell: ({ row }) => {
        if (row.original.crossReference !== 'unexpected') {
          return <span className='text-muted-foreground text-sm'>—</span>;
        }
        return (
          <Button
            size='sm'
            variant='outline'
            disabled={!canAdopt}
            onClick={() => onAdopt(row.original)}
          >
            <Icons.add className='h-4 w-4' /> Adopt
          </Button>
        );
      }
    }
  ];
}
