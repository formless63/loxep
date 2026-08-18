import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import { dispositionOptions } from '@/features/documents/constants';
import type { CandidateDto } from '@/server/documents-functions';
import { createColumns } from './columns';

/**
 * The candidate review table — one document's staged/parsed lines, disposed
 * per row via an inline `Select` (no server round trip per keystroke; each
 * change is its own mutation, invalidated by the caller). Small, in-memory
 * lists (a document's candidates), so pagination is local rather than
 * server-driven, mirroring `MovementsTable`'s shape.
 *
 * A26 (loxep-wx3) — description/amount are inline-editable, a row can be
 * removed, and selecting rows (via the `select` column — `useDataTable`'s
 * row-selection feature was already registered but unused everywhere) surfaces
 * a bulk-disposition bar above the table, calling `bulkSetLineDisposition`
 * through the caller-supplied `onBulkDispositionChange`. Confirmed rows have
 * no checkbox at all (`columns.tsx`'s `select` cell renders `null`) — the
 * server refuses to touch them anyway, matching every other action here.
 */
export default function CandidatesTable({
  candidates,
  onDispositionChange,
  onUpdateLine,
  onRemoveLine,
  onBulkDispositionChange
}: {
  candidates: CandidateDto[];
  onDispositionChange: (candidateId: string, disposition: string) => void;
  onUpdateLine: (
    candidateId: string,
    patch: { description?: string | null; lineAmount?: string | null }
  ) => void;
  onRemoveLine: (candidateId: string) => void;
  onBulkDispositionChange: (candidateIds: string[], disposition: string) => void;
}) {
  const columns = React.useMemo(
    () => createColumns(onDispositionChange, onUpdateLine, onRemoveLine),
    [onDispositionChange, onUpdateLine, onRemoveLine]
  );
  const [bulkDisposition, setBulkDisposition] = React.useState<string>(
    dispositionOptions[0]?.value ?? ''
  );

  const { table } = useDataTable({
    data: candidates,
    columns,
    pageCount: 1,
    getRowId: (candidate) => candidate.id,
    shallow: true,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 50 },
      columnPinning: { start: ['select'], end: ['actions'] }
    }
  });

  const selectedIds = table.getSelectedRowModel().rows.map((row) => row.original.id);

  return (
    <div className='flex flex-col gap-2'>
      {selectedIds.length > 0 && (
        <div className='bg-muted/50 flex flex-wrap items-center gap-2 rounded-md border p-2'>
          <span className='text-sm font-medium'>{selectedIds.length} line(s) selected</span>
          <Select value={bulkDisposition} onValueChange={setBulkDisposition}>
            <SelectTrigger size='sm' className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dispositionOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type='button'
            size='sm'
            onClick={() => {
              onBulkDispositionChange(selectedIds, bulkDisposition);
              table.resetRowSelection();
            }}
          >
            Apply to selected
          </Button>
          <Button type='button' size='sm' variant='ghost' onClick={() => table.resetRowSelection()}>
            Clear
          </Button>
        </div>
      )}
      <DataTable table={table} />
    </div>
  );
}
