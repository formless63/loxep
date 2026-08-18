import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { useTable } from '@tanstack/react-table';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { DataTable } from '@/components/ui/table/data-table';
import { Icons } from '@/components/icons';
import { cn } from '@/lib/utils';
import { dataTableFeatures, type DataTableFeatures } from '@/lib/table-features';
import { duplicateOrderCandidatesQuery } from '@/features/commerce/api/queries';
import { providerLabel } from '@/features/commerce/constants';
import type { DuplicateOrderCandidateDto } from '@/server/orders-functions';

function buildColumns(): ColumnDef<DataTableFeatures, DuplicateOrderCandidateDto>[] {
  return [
    {
      id: 'provider',
      accessorKey: 'provider',
      header: 'Provider',
      cell: ({ row }) => <span className='font-medium'>{providerLabel(row.original.provider)}</span>
    },
    {
      id: 'sourceAccountKey',
      accessorKey: 'sourceAccountKey',
      header: 'Source account',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>{row.original.sourceAccountKey}</span>
      )
    },
    {
      id: 'externalOrderId',
      accessorKey: 'externalOrderId',
      header: 'Provider order id',
      cell: ({ row }) => row.original.externalOrderId
    },
    {
      id: 'orderIds',
      accessorKey: 'orderIds',
      header: 'Orders',
      cell: ({ row }) => (
        <div className='flex flex-wrap gap-2'>
          {row.original.orderIds.map((orderId, index) => (
            <Link
              key={orderId}
              to='/commerce/orders/$id'
              params={{ id: orderId }}
              className='hover:underline'
            >
              #{index + 1}
            </Link>
          ))}
        </div>
      )
    }
  ];
}

/**
 * `findDuplicateOrderCandidates` (loxep-7fs, A22, `orders.ts` design open
 * question 2) — READ-ONLY diagnostic. Duplicates are already silently
 * excluded from every profitability figure
 * (`o.duplicate_of_order_id is null` in every predicate); this makes the
 * exclusion visible to a human instead of silent. Opt-in and collapsed by
 * default — the same "the panel is the deliverable, never a nag" posture
 * `unmatched-devices-panel` follows — and absent entirely when there is
 * genuinely nothing to adjudicate.
 */
export default function DuplicateOrdersPanel() {
  const { data, isPending, isError } = useQuery(duplicateOrderCandidatesQuery);
  const [open, setOpen] = React.useState(false);

  if (isPending) return null;
  if (isError) return null;
  if (data.length === 0) return null;

  const columns = buildColumns();

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className='rounded-xl border bg-card py-4 text-card-foreground shadow-sm'
    >
      <CollapsibleTrigger className='flex w-full items-center justify-between gap-2 px-4 text-left'>
        <div className='space-y-1'>
          <p className='text-base leading-none font-semibold'>
            Possible duplicate orders
            <span className='text-muted-foreground ml-2 font-normal'>({data.length})</span>
          </p>
          <p className='text-muted-foreground text-sm'>
            The same provider order id ingested more than once, usually across two connections to
            the same account. Excluded from every totals figure until adjudicated on the order
            detail page.
          </p>
        </div>
        <Icons.chevronDown
          className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')}
          aria-hidden='true'
        />
      </CollapsibleTrigger>
      <CollapsibleContent className='px-4 pt-4'>
        <DuplicatesDataTable rows={data} columns={columns} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function DuplicatesDataTable({
  rows,
  columns
}: {
  rows: DuplicateOrderCandidateDto[];
  columns: ColumnDef<DataTableFeatures, DuplicateOrderCandidateDto>[];
}) {
  // Shares its route with the orders table, which already owns the
  // page/perPage/sort URL keys — local `useTable` + `manualPagination`
  // avoids fighting over them, same as `unmatched-devices-panel`.
  const table = useTable({
    data: rows,
    columns,
    features: dataTableFeatures,
    getRowId: (row) => `${row.provider}|${row.sourceAccountKey}|${row.externalOrderId}`,
    manualPagination: true
  });

  return <DataTable table={table} />;
}
