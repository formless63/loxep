import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { DataTableColumnHeader } from '@/components/ui/table/data-table-column-header';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';
import { formatDate, formatMoney } from '@/lib/format';
import type { CandidateDto } from '@/server/documents-functions';
import {
  CONFIRMABLE_AS_ACQUISITION_DISPOSITIONS,
  dispositionLabel,
  dispositionOptions
} from '@/features/documents/constants';

export function createColumns(
  onDispositionChange: (candidateId: string, disposition: string) => void
): ColumnDef<DataTableFeatures, CandidateDto>[] {
  return [
    {
      id: 'lineNumber',
      accessorKey: 'lineNumber',
      enableSorting: false,
      header: '#',
      cell: ({ cell }) => (
        <span className='text-muted-foreground tabular-nums'>{cell.getValue<number>()}</span>
      )
    },
    {
      id: 'lineDate',
      accessorKey: 'lineDate',
      header: ({ column }: { column: Column<DataTableFeatures, CandidateDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Date' />
      ),
      cell: ({ cell }) => {
        const value = cell.getValue<string | null>();
        return (
          <span className='text-muted-foreground tabular-nums'>
            {value ? formatDate(value) : '—'}
          </span>
        );
      }
    },
    {
      id: 'description',
      accessorKey: 'description',
      enableSorting: false,
      header: 'Description',
      cell: ({ cell }) =>
        cell.getValue<string | null>() ?? <span className='text-muted-foreground'>—</span>
    },
    {
      id: 'lineAmount',
      accessorKey: 'lineAmount',
      header: ({ column }: { column: Column<DataTableFeatures, CandidateDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Amount' />
      ),
      cell: ({ row }) => {
        const amount = row.original.lineAmount;
        if (amount === null) {
          return <span className='text-destructive text-right block'>missing</span>;
        }
        return (
          <div className='text-right font-medium tabular-nums'>
            {formatMoney(amount, row.original.currency ?? 'USD')}
          </div>
        );
      }
    },
    {
      id: 'confidence',
      accessorKey: 'confidence',
      enableSorting: false,
      header: 'Confidence',
      cell: ({ cell }) => {
        const value = cell.getValue<string | null>();
        return (
          <span className='text-muted-foreground tabular-nums'>
            {value ? `${Math.round(Number(value) * 100)}%` : '—'}
          </span>
        );
      }
    },
    {
      id: 'disposition',
      accessorKey: 'disposition',
      enableSorting: false,
      header: 'Disposition',
      cell: ({ row }) => {
        const confirmed = row.original.confirmedAt !== null;
        if (confirmed) {
          const badge = (
            <Badge variant='success'>
              <Icons.check />
              {dispositionLabel(row.original.disposition)}
            </Badge>
          );
          // `targetKind`/`targetId` are stamped by `confirmLinesAsExpense`/
          // `confirmLinesAsAcquisition` — link out to the record this line
          // became rather than dead-ending on the badge (loxep-0l5/loxep-4mg,
          // extended to the acquisition path by loxep-cd3.6, M6).
          if (row.original.targetKind === 'expense' && row.original.targetId) {
            return (
              <Link
                to='/finance/expenses/$id'
                params={{ id: row.original.targetId }}
                className='inline-flex hover:underline'
              >
                {badge}
              </Link>
            );
          }
          if (row.original.targetKind === 'acquisition' && row.original.targetId) {
            return (
              <Link
                to='/inventory/acquisitions/$id'
                params={{ id: row.original.targetId }}
                className='inline-flex hover:underline'
              >
                {badge}
              </Link>
            );
          }
          return badge;
        }
        return (
          <Select
            value={row.original.disposition}
            onValueChange={(value) => onDispositionChange(row.original.id, value)}
          >
            <SelectTrigger size='sm' className='w-44'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dispositionOptions.map((option) => {
                // `acquisition_cost`/`inventory_intake` open the acquisition-
                // lot picker (loxep-cd3.6, M6) rather than confirming inline
                // here — the hint says so instead of leaving the choice
                // unexplained. Every other option either confirms via the
                // panel's "Confirm as expense" action or is a terminal,
                // no-confirm-step disposition (personal/not_mine/duplicate/
                // discarded/pending), so it gets no hint.
                const opensLotPicker = CONFIRMABLE_AS_ACQUISITION_DISPOSITIONS.has(option.value);
                return (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                    {opensLotPicker && (
                      <span className='text-muted-foreground'> — opens the lot picker</span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        );
      }
    },
    {
      id: 'confirmedAt',
      accessorKey: 'confirmedAt',
      enableSorting: false,
      header: 'Status',
      cell: ({ row }) =>
        row.original.confirmedAt ? (
          <Badge variant='success'>Confirmed</Badge>
        ) : (
          <Badge variant='outline'>Unresolved</Badge>
        )
    }
  ];
}
