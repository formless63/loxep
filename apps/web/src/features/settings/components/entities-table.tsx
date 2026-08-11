import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { deactivateEntity, type EntityDto } from '@/server/admin-functions';
import { entitiesQuery } from '@/features/settings/api/queries';
import { entityKindLabel } from '@/features/settings/constants';
import { StatusBadge } from '@/features/settings/components/settings-page';
import EntityFormDialog from '@/features/settings/components/entity-form-dialog';

/** Depth-first ordering so children render indented beneath their parent. */
function treeOrder(entities: EntityDto[]): { entity: EntityDto; depth: number }[] {
  const byParent = new Map<string | null, EntityDto[]>();
  const ids = new Set(entities.map((entity) => entity.id));
  for (const entity of entities) {
    // Parents filtered out of the list (none today) fall back to root level.
    const parentKey =
      entity.parentEntityId !== null && ids.has(entity.parentEntityId)
        ? entity.parentEntityId
        : null;
    const siblings = byParent.get(parentKey) ?? [];
    siblings.push(entity);
    byParent.set(parentKey, siblings);
  }
  const ordered: { entity: EntityDto; depth: number }[] = [];
  const visit = (parentKey: string | null, depth: number) => {
    for (const entity of byParent.get(parentKey) ?? []) {
      ordered.push({ entity, depth });
      visit(entity.id, depth + 1);
    }
  };
  visit(null, 0);
  return ordered;
}

export default function EntitiesTable({ isAdmin }: { isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery(entitiesQuery);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EntityDto | null>(null);
  const [deactivating, setDeactivating] = React.useState<EntityDto | null>(null);

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateEntity({ data: { id } }),
    onSuccess: () => {
      toast.success('Entity deactivated');
      queryClient.invalidateQueries({ queryKey: entitiesQuery.queryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to deactivate entity');
    },
    onSettled: () => setDeactivating(null)
  });

  const entities = data ?? [];
  const rows = treeOrder(entities);
  const nameById = new Map(entities.map((entity) => [entity.id, entity.name]));

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (entity: EntityDto) => {
    setEditing(entity);
    setDialogOpen(true);
  };

  if (isPending) {
    return <Skeleton className='h-64 w-full' />;
  }

  return (
    <div className='flex flex-col gap-4'>
      {isAdmin && (
        <div className='flex justify-end'>
          <Button size='sm' onClick={openCreate}>
            New entity
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No economic entities</EmptyTitle>
            <EmptyDescription>
              Economic entities are attribution/business-context records — a person, business, or
              operating identity whose activity Loxep may attribute and analyze.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Children</TableHead>
              {isAdmin && <TableHead className='text-right'>Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ entity, depth }) => (
              <TableRow key={entity.id}>
                <TableCell>
                  <div className='flex flex-col' style={{ paddingLeft: `${depth * 1.25}rem` }}>
                    <span className='font-medium'>{entity.name}</span>
                    {entity.legalName && (
                      <span className='text-muted-foreground text-xs'>{entity.legalName}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant='outline'>{entityKindLabel(entity.kind)}</Badge>
                </TableCell>
                <TableCell className='text-muted-foreground'>
                  {entity.parentEntityId ? (nameById.get(entity.parentEntityId) ?? '—') : '—'}
                </TableCell>
                <TableCell>
                  <StatusBadge ok={entity.active} okLabel='active' failLabel='inactive' />
                </TableCell>
                <TableCell className='text-muted-foreground'>{entity.childCount}</TableCell>
                {isAdmin && (
                  <TableCell className='text-right'>
                    <div className='flex justify-end gap-2'>
                      <Button size='sm' variant='outline' onClick={() => openEdit(entity)}>
                        Edit
                      </Button>
                      {entity.active && (
                        <Button size='sm' variant='ghost' onClick={() => setDeactivating(entity)}>
                          Deactivate
                        </Button>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {dialogOpen && (
        <EntityFormDialog
          key={editing?.id ?? 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          entity={editing}
          entities={entities}
        />
      )}

      <AlertDialog
        open={deactivating !== null}
        onOpenChange={(open) => !open && setDeactivating(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactivating?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Deactivation is a soft state — attributed data keeps referencing the entity, but it
              can no longer receive new attributions. Entities are never deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deactivateMutation.isPending}
              onClick={() => deactivating && deactivateMutation.mutate(deactivating.id)}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
