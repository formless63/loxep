import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { Icons } from '@/components/icons';
import { archiveCatalogItem } from '@/server/commerce-functions';
import { catalogItemsQuery } from '@/features/commerce/api/queries';
import type { CatalogItemListItemDto } from '@/server/commerce-functions';

interface CellActionProps {
  data: CatalogItemListItemDto;
  onEdit: (item: CatalogItemListItemDto) => void;
}

/** Row action menu — edit and archive (`CatalogService.updateCatalogItem`/`archiveCatalogItem`). */
export function CellAction({ data, onEdit }: CellActionProps) {
  const queryClient = useQueryClient();
  const [archiving, setArchiving] = useState(false);

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveCatalogItem({ data: { id } }),
    onSuccess: () => {
      toast.success('Catalog item archived');
      void queryClient.invalidateQueries({ queryKey: catalogItemsQuery.queryKey });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Failed to archive catalog item');
    },
    onSettled: () => setArchiving(false)
  });

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' size='icon-sm'>
            <span className='sr-only'>Open menu</span>
            <Icons.ellipsis className='h-4 w-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuGroup>
            <DropdownMenuLabel>Actions</DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onEdit(data)}>
            <Icons.edit className='mr-2 h-4 w-4' /> Edit
          </DropdownMenuItem>
          {data.status !== 'archived' && (
            <DropdownMenuItem onClick={() => setArchiving(true)}>
              <Icons.eyeOff className='mr-2 h-4 w-4' /> Archive
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={archiving} onOpenChange={setArchiving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {data.sku}?</AlertDialogTitle>
            <AlertDialogDescription>
              Archived, never deleted — order lines may reference this item forever. It stops
              appearing as a target for new listings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() => archiveMutation.mutate(data.id)}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
