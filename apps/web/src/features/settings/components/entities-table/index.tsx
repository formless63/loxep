import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { getExpandedRowModel } from '@tanstack/react-table';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/table/data-table';
import { DataTableSkeleton } from '@/components/ui/table/data-table-skeleton';
import { DataTableToolbar } from '@/components/ui/table/data-table-toolbar';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Icons } from '@/components/icons';
import { useDataTable } from '@/hooks/use-data-table';
import { entitiesQuery } from '@/features/settings/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import EntityFormDialog from '@/features/settings/components/entity-form-dialog';
import type { EntityDto } from '@/server/admin-functions';
import { buildEntityTree, getColumns, type EntityTreeNode } from './columns';

export default function EntitiesTable({ isAdmin }: { isAdmin: boolean }) {
  const { data, isPending, isError, error, refetch } = useQuery(entitiesQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EntityDto | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (entity: EntityDto) => {
    setEditing(entity);
    setDialogOpen(true);
  };

  const entities = data ?? [];
  const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));
  // Small admin list — recomputed each render rather than memoized, since
  // `nameById` is itself a fresh object every render.
  const columns = getColumns(isAdmin, nameById, openEdit);

  let body: React.ReactNode;
  if (isPending) {
    body = <DataTableSkeleton columnCount={columns.length} filterCount={0} />;
  } else if (isError) {
    body = (
      <QueryErrorAlert error={error} title='Failed to load entities' onRetry={() => refetch()} />
    );
  } else if (entities.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <Icons.teams />
          </EmptyMedia>
          <EmptyTitle>No economic entities</EmptyTitle>
          <EmptyDescription>
            Economic entities are attribution/business-context records — a person, business, or
            operating identity whose activity Loxep may attribute and analyze.
          </EmptyDescription>
        </EmptyHeader>
        {isAdmin && (
          <EmptyContent>
            <Button size='sm' onClick={openCreate}>
              New entity
            </Button>
          </EmptyContent>
        )}
      </Empty>
    );
  } else {
    body = (
      <EntitiesDataTable
        tree={buildEntityTree(entities)}
        columns={columns}
        isAdmin={isAdmin}
        onCreate={openCreate}
      />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {body}
      {dialogOpen && (
        <EntityFormDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          entity={editing}
          entities={entities}
        />
      )}
    </div>
  );
}

/**
 * The tree's own rows drive `getSubRows`/`getExpandedRowModel` — every
 * entity is fetched already, so there is nothing to page server-side, and
 * splitting a hierarchy across pages would separate a parent from its
 * children. `columnPinning` still pins the actions column right.
 */
function EntitiesDataTable({
  tree,
  columns,
  isAdmin,
  onCreate
}: {
  tree: EntityTreeNode[];
  columns: ReturnType<typeof getColumns>;
  isAdmin: boolean;
  onCreate: () => void;
}) {
  const { table } = useDataTable({
    data: tree,
    columns,
    pageCount: 1,
    shallow: true,
    debounceMs: 500,
    getSubRows: (row) => (row.children.length > 0 ? row.children : undefined),
    getExpandedRowModel: getExpandedRowModel(),
    initialState: { expanded: true, columnPinning: { right: ['actions'] } }
  });

  return (
    <DataTable table={table}>
      <DataTableToolbar table={table}>
        {isAdmin && (
          <Button size='sm' onClick={onCreate}>
            New entity
          </Button>
        )}
      </DataTableToolbar>
    </DataTable>
  );
}
