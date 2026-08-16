import * as React from 'react';
import { DataTable } from '@/components/ui/table/data-table';
import { useDataTable } from '@/hooks/use-data-table';
import type { CandidateDto } from '@/server/documents-functions';
import { createColumns } from './columns';

/**
 * The candidate review table — one document's staged/parsed lines, disposed
 * per row via an inline `Select` (no server round trip per keystroke; each
 * change is its own mutation, invalidated by the caller). Small, in-memory
 * lists (a document's candidates), so pagination is local rather than
 * server-driven, mirroring `MovementsTable`'s shape.
 */
export default function CandidatesTable({
  candidates,
  onDispositionChange
}: {
  candidates: CandidateDto[];
  onDispositionChange: (candidateId: string, disposition: string) => void;
}) {
  const columns = React.useMemo(() => createColumns(onDispositionChange), [onDispositionChange]);

  const { table } = useDataTable({
    data: candidates,
    columns,
    pageCount: 1,
    getRowId: (candidate) => candidate.id,
    shallow: true,
    initialState: {
      pagination: { pageIndex: 0, pageSize: 50 }
    }
  });

  return <DataTable table={table} />;
}
