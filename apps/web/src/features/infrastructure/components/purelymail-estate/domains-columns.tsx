import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import { ToneBadge } from '@/features/settings/components/status-tone';
import type { DataTableFeatures } from '@/lib/table-features';
import type { PurelymailEstateDomainDto } from '@/server/purelymail-estate-functions';
import { PurelymailDomainRowActions } from './domain-row-actions';

/**
 * Provider-truth verbatim (Rule P3): `dns.passesMx`/`passesSpf`/`passesDkim`/
 * `passesDmarc` render as pass/fail booleans exactly as Purelymail reports
 * them, never collapsed into a single Loxep-coined "healthy" verdict.
 */
function DnsChecksCell({ domain }: { domain: PurelymailEstateDomainDto }) {
  const checks: { label: string; passes: boolean }[] = [
    { label: 'MX', passes: domain.dns.passesMx },
    { label: 'SPF', passes: domain.dns.passesSpf },
    { label: 'DKIM', passes: domain.dns.passesDkim },
    { label: 'DMARC', passes: domain.dns.passesDmarc }
  ];
  return (
    <div className='flex flex-wrap gap-1'>
      {checks.map((check) => (
        <ToneBadge key={check.label} tone={check.passes ? 'success' : 'destructive'}>
          {check.label}
        </ToneBadge>
      ))}
    </div>
  );
}

function LoxepDomainCell({ domain }: { domain: PurelymailEstateDomainDto }) {
  if (domain.loxep === null) {
    return <span className='text-muted-foreground text-sm'>Not declared in Loxep</span>;
  }
  return (
    <div className='flex flex-wrap items-center gap-1'>
      <Badge variant={domain.loxep.registeredAtProvider ? 'secondary' : 'outline'}>
        <Icons.circleCheck className='mr-1 h-3 w-3' />
        {domain.loxep.state}
      </Badge>
      {domain.loxep.ownershipVerified && <Badge variant='outline'>ownership verified</Badge>}
    </div>
  );
}

export function purelymailDomainColumns(
  connectionId: string
): ColumnDef<DataTableFeatures, PurelymailEstateDomainDto>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: ({
        column
      }: {
        column: Column<DataTableFeatures, PurelymailEstateDomainDto, unknown>;
      }) => <DataTableColumnHeader column={column} title='Domain' />,
      cell: ({ row }) => <span className='font-mono font-medium'>{row.original.name}</span>,
      meta: {
        label: 'Domain',
        placeholder: 'Search domains...',
        variant: 'text' as const,
        icon: Icons.text
      },
      enableColumnFilter: true
    },
    {
      id: 'dns',
      header: 'DNS checks',
      cell: ({ row }) => <DnsChecksCell domain={row.original} />
    },
    {
      id: 'flags',
      header: 'Flags',
      cell: ({ row }) => {
        const domain = row.original;
        return (
          <div className='flex flex-wrap gap-1'>
            {domain.isShared && <Badge variant='outline'>shared</Badge>}
            {domain.allowAccountReset && <Badge variant='destructive'>allows account reset</Badge>}
            {domain.symbolicSubaddressing && <Badge variant='outline'>subaddressing</Badge>}
          </div>
        );
      }
    },
    {
      id: 'loxep',
      header: 'Loxep',
      cell: ({ row }) =>
        row.original.loxep === null ? (
          <LoxepDomainCell domain={row.original} />
        ) : (
          <Link
            to='/infrastructure/domains/$name'
            params={{ name: row.original.name }}
            className='underline-offset-4 hover:underline'
          >
            <LoxepDomainCell domain={row.original} />
          </Link>
        )
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) =>
        row.original.loxep !== null ? (
          <PurelymailDomainRowActions
            connectionId={connectionId}
            domainId={row.original.loxep.managedDomainId}
          />
        ) : null
    }
  ];
}
