import * as React from 'react';
import type { Column, ColumnDef } from '@tanstack/react-table';
import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
  ACQUISITION_LOT_DISPOSITIONS,
  dispositionLabel,
  dispositionOptions
} from '@/features/documents/constants';

/**
 * A26 (loxep-wx3) — always-editable inline `Input`, committed on blur (only
 * when the value actually changed), rather than a separate edit mode: this
 * is a small, in-memory review table, and a click-to-edit affordance would
 * be one more state to manage for no real benefit here. Disabled once
 * confirmed — `updateCandidateLine`'s own refusal ("a confirmed line is
 * evidence of a domain write") would just bounce back as an error toast
 * otherwise.
 */
function EditableTextCell({
  value,
  confirmed,
  align = 'left',
  ariaLabel,
  onCommit
}: {
  value: string;
  confirmed: boolean;
  align?: 'left' | 'right';
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);

  if (confirmed) {
    return (
      <span className={align === 'right' ? 'block text-right' : undefined}>{value || '—'}</span>
    );
  }

  return (
    <Input
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      aria-label={ariaLabel}
      className={align === 'right' ? 'text-right tabular-nums' : undefined}
    />
  );
}

export function createColumns(
  onDispositionChange: (candidateId: string, disposition: string) => void,
  onUpdateLine: (
    candidateId: string,
    patch: { description?: string | null; lineAmount?: string | null }
  ) => void,
  onRemoveLine: (candidateId: string) => void
): ColumnDef<DataTableFeatures, CandidateDto>[] {
  return [
    {
      id: 'select',
      enableSorting: false,
      enableHiding: false,
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && 'indeterminate')
          }
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(!!value)}
          aria-label='Select all rows'
        />
      ),
      cell: ({ row }) =>
        row.original.confirmedAt === null ? (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={`Select line ${row.original.lineNumber}`}
          />
        ) : null
    },
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
      cell: ({ row }) => (
        <EditableTextCell
          value={row.original.description ?? ''}
          confirmed={row.original.confirmedAt !== null}
          ariaLabel={`Line ${row.original.lineNumber} description`}
          onCommit={(next) =>
            onUpdateLine(row.original.id, { description: next.trim() === '' ? null : next.trim() })
          }
        />
      )
    },
    {
      id: 'lineAmount',
      accessorKey: 'lineAmount',
      header: ({ column }: { column: Column<DataTableFeatures, CandidateDto, unknown> }) => (
        <DataTableColumnHeader column={column} title='Amount' />
      ),
      cell: ({ row }) => {
        const confirmed = row.original.confirmedAt !== null;
        if (confirmed) {
          const amount = row.original.lineAmount;
          return amount === null ? (
            <span className='text-destructive block text-right'>missing</span>
          ) : (
            <div className='text-right font-medium tabular-nums'>
              {formatMoney(amount, row.original.currency ?? 'USD')}
            </div>
          );
        }
        return (
          <EditableTextCell
            value={row.original.lineAmount ?? ''}
            confirmed={false}
            align='right'
            ariaLabel={`Line ${row.original.lineNumber} amount`}
            onCommit={(next) =>
              onUpdateLine(row.original.id, { lineAmount: next.trim() === '' ? null : next.trim() })
            }
          />
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
          // `inventory_item` (loxep-ytu) — `confirmCandidatesAsIntake`'s
          // target: an `inventory_intake`-dispositioned line becomes an
          // ACTUAL stock row, not a cost row, so it links to the item
          // itself rather than to its lot.
          if (row.original.targetKind === 'inventory_item' && row.original.targetId) {
            return (
              <Link
                to='/inventory/stock/$id'
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
                // lot picker (loxep-cd3.6, M6; loxep-ytu) rather than
                // confirming inline here — the hint says so instead of
                // leaving the choice unexplained. Every other option either
                // confirms via the panel's "Confirm as expense" action or is
                // a terminal, no-confirm-step disposition (personal/
                // not_mine/duplicate/discarded/pending), so it gets no hint.
                const opensLotPicker = ACQUISITION_LOT_DISPOSITIONS.has(option.value);
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
    },
    {
      id: 'actions',
      enableSorting: false,
      header: '',
      cell: ({ row }) =>
        row.original.confirmedAt === null && (
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-8'
            aria-label={`Remove line ${row.original.lineNumber}`}
            onClick={() => onRemoveLine(row.original.id)}
          >
            <Icons.trash />
          </Button>
        )
    }
  ];
}
