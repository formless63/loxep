import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import { toastError } from '@/lib/errors';
import { attributeConnection, type ConnectionDto, type EntityDto } from '@/server/admin-functions';
import { connectionsQuery } from '@/features/settings/api/queries';
import { NO_ENTITY_VALUE } from '@/features/settings/constants';

/**
 * Row-scoped attribution select: its own mutation instance, so choosing an
 * entity on one row never touches another row's control state.
 */
export function AttributionCell({
  connection,
  entities,
  isAdmin
}: {
  connection: ConnectionDto;
  entities: EntityDto[];
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();

  const attributionMutation = useMutation({
    mutationFn: (economicEntityId: string | null) =>
      attributeConnection({ data: { id: connection.id, economicEntityId } }),
    onSuccess: () => {
      toast.success('Attribution updated');
      queryClient.invalidateQueries({ queryKey: connectionsQuery.queryKey });
    },
    onError: (error) => toastError(error, 'Failed to update attribution')
  });

  if (!isAdmin) {
    const entityName = connection.economicEntityId
      ? (entities.find((entity) => entity.id === connection.economicEntityId)?.name ?? '—')
      : '—';
    return <span className='text-muted-foreground'>{entityName}</span>;
  }

  const activeEntities = entities.filter((entity) => entity.active);

  return (
    <Select
      value={connection.economicEntityId ?? NO_ENTITY_VALUE}
      onValueChange={(value) =>
        attributionMutation.mutate(value === NO_ENTITY_VALUE ? null : value)
      }
    >
      <SelectTrigger size='sm' className='min-w-36'>
        <SelectValue placeholder='No attribution' />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_ENTITY_VALUE}>No attribution</SelectItem>
        {activeEntities.map((entity) => (
          <SelectItem key={entity.id} value={entity.id}>
            {entity.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
