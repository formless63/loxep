import type { ColumnDef, Row } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { BooleanStatusBadge } from '@/features/settings/components/status-tone';
import { entityKindLabel } from '@/features/settings/constants';
import type { DataTableFeatures } from '@/lib/table-features';
import type { EntityDto } from '@/server/admin-functions';
import { CellAction } from './cell-action';

export interface EntityTreeNode extends EntityDto {
  children: EntityTreeNode[];
}

/**
 * Nests entities under their parent so TanStack Table's native `getSubRows`
 * / `getExpandedRowModel` own the tree — indentation comes from the table's
 * own `row.depth`, not a hand-rolled depth-first traversal.
 */
export function buildEntityTree(entities: EntityDto[]): EntityTreeNode[] {
  const ids = new Set(entities.map((entity) => entity.id));
  const byId = new Map<string, EntityTreeNode>(
    entities.map((entity) => [entity.id, { ...entity, children: [] }])
  );
  const roots: EntityTreeNode[] = [];
  for (const entity of entities) {
    const node = byId.get(entity.id);
    if (!node) continue;
    const parentKey =
      entity.parentEntityId !== null && ids.has(entity.parentEntityId)
        ? entity.parentEntityId
        : null;
    if (parentKey === null) {
      roots.push(node);
    } else {
      byId.get(parentKey)?.children.push(node);
    }
  }
  return roots;
}

/**
 * No column here is sortable or filterable: order is the entity hierarchy,
 * not a user-chosen sort, and filtering a tree by a leaf column would orphan
 * children whose parent didn't match. `nameById` resolves the "Parent"
 * column without a second lookup pass.
 */
export function getColumns(
  isAdmin: boolean,
  nameById: Map<string, string>,
  onEdit: (entity: EntityDto) => void
): ColumnDef<DataTableFeatures, EntityTreeNode>[] {
  const columns: ColumnDef<DataTableFeatures, EntityTreeNode>[] = [
    {
      id: 'name',
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }: { row: Row<DataTableFeatures, EntityTreeNode> }) => (
        <div className='flex flex-col' style={{ paddingLeft: `${row.depth * 1.25}rem` }}>
          <span className='font-medium'>{row.original.name}</span>
          {row.original.legalName && (
            <span className='text-muted-foreground text-xs'>{row.original.legalName}</span>
          )}
        </div>
      )
    },
    {
      id: 'kind',
      header: 'Kind',
      cell: ({ row }) => <Badge variant='outline'>{entityKindLabel(row.original.kind)}</Badge>
    },
    {
      id: 'parentEntityId',
      header: 'Parent',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>
          {row.original.parentEntityId ? (nameById.get(row.original.parentEntityId) ?? '—') : '—'}
        </span>
      )
    },
    {
      id: 'active',
      header: 'Status',
      cell: ({ row }) => (
        <BooleanStatusBadge
          value={row.original.active}
          trueLabel='active'
          falseLabel='inactive'
          falseTone='outline'
        />
      )
    },
    {
      id: 'childCount',
      header: () => <div className='text-right'>Children</div>,
      cell: ({ row }) => (
        <div className='text-muted-foreground text-right tabular-nums'>
          {row.original.childCount}
        </div>
      )
    }
  ];

  if (isAdmin) {
    columns.push({
      id: 'actions',
      cell: ({ row }) => <CellAction data={row.original} onEdit={onEdit} />
    });
  }

  return columns;
}
