import type { Column, ReactTable, RowData } from '@tanstack/react-table';
import * as React from 'react';

import { DataTableDateFilter } from '@/components/ui/table/data-table-date-filter';
import { DataTableFacetedFilter } from '@/components/ui/table/data-table-faceted-filter';
import { DataTableSliderFilter } from '@/components/ui/table/data-table-slider-filter';
import { DataTableViewOptions } from '@/components/ui/table/data-table-view-options';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { Icons } from '@/components/icons';
import type { DataTableFeatures } from '@/lib/table-features';

interface DataTableToolbarProps<TData extends RowData> extends React.ComponentProps<'div'> {
  table: ReactTable<DataTableFeatures, TData>;
}

export function DataTableToolbar<TData extends RowData>({
  table,
  children,
  className,
  ...props
}: DataTableToolbarProps<TData>) {
  const isMobile = useIsMobile();
  const isFiltered = table.state.columnFilters.length > 0;
  const activeFilterCount = table.state.columnFilters.length;

  const columns = React.useMemo(
    () => table.getAllColumns().filter((column) => column.getCanFilter()),
    [table]
  );

  const onReset = React.useCallback(() => {
    table.resetColumnFilters();
  }, [table]);

  // Rule M2.3: below 768px the toolbar collapses to one filter button (funnel
  // + active-filter count) opening a Sheet with the same per-column filter
  // controls the desktop toolbar renders inline; view-options (a
  // column-visibility popover with no mobile-sized target) hides. The
  // desktop branch below is untouched so >=768px renders byte-identical to
  // before this rule landed.
  if (isMobile) {
    return (
      <div
        role='toolbar'
        aria-orientation='horizontal'
        className={cn('flex w-full items-center justify-between gap-2 p-1', className)}
        {...props}
      >
        <Sheet>
          <SheetTrigger asChild>
            <Button aria-label='Filters' variant='outline' size='sm' className='relative'>
              <Icons.filter />
              Filters
              {activeFilterCount > 0 && (
                <Badge
                  variant='secondary'
                  className='ml-1 h-5 min-w-5 justify-center px-1 tabular-nums'
                >
                  {activeFilterCount}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side='bottom' className='max-h-[80vh] overflow-y-auto'>
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className='flex flex-col gap-3 px-4 pb-4 [&_button]:w-full [&_input]:w-full'>
              {columns.map((column) => (
                <DataTableToolbarFilter key={column.id} column={column} />
              ))}
              {isFiltered && (
                <Button
                  aria-label='Reset filters'
                  variant='outline'
                  size='sm'
                  className='self-start border-dashed'
                  onClick={onReset}
                >
                  <Icons.close />
                  Reset
                </Button>
              )}
            </div>
          </SheetContent>
        </Sheet>
        {children && <div className='flex items-center gap-2'>{children}</div>}
      </div>
    );
  }

  return (
    <div
      role='toolbar'
      aria-orientation='horizontal'
      className={cn('flex w-full items-start justify-between gap-2 p-1', className)}
      {...props}
    >
      <div className='flex flex-1 flex-wrap items-center gap-2'>
        {columns.map((column) => (
          <DataTableToolbarFilter key={column.id} column={column} />
        ))}
        {isFiltered && (
          <Button
            aria-label='Reset filters'
            variant='outline'
            size='sm'
            className='border-dashed'
            onClick={onReset}
          >
            <Icons.close />
            Reset
          </Button>
        )}
      </div>
      <div className='flex items-center gap-2'>
        {children}
        <DataTableViewOptions table={table} />
      </div>
    </div>
  );
}
interface DataTableToolbarFilterProps<TData extends RowData> {
  column: Column<DataTableFeatures, TData>;
}

function DataTableToolbarFilter<TData extends RowData>({
  column
}: DataTableToolbarFilterProps<TData>) {
  {
    const columnMeta = column.columnDef.meta;

    const onFilterRender = React.useCallback(() => {
      if (!columnMeta?.variant) return null;

      switch (columnMeta.variant) {
        case 'text':
          return (
            <Input
              aria-label={columnMeta.label ?? column.id}
              placeholder={columnMeta.placeholder ?? columnMeta.label}
              value={(column.getFilterValue() as string) ?? ''}
              onChange={(event) => column.setFilterValue(event.target.value)}
              className='h-8 w-40 lg:w-56'
            />
          );

        case 'number':
          return (
            <div className='relative'>
              <Input
                aria-label={columnMeta.label ?? column.id}
                type='number'
                inputMode='numeric'
                placeholder={columnMeta.placeholder ?? columnMeta.label}
                value={(column.getFilterValue() as string) ?? ''}
                onChange={(event) => column.setFilterValue(event.target.value)}
                className={cn('h-8 w-[120px]', columnMeta.unit && 'pr-8')}
              />
              {columnMeta.unit && (
                <span className='bg-accent text-muted-foreground absolute top-0 right-0 bottom-0 flex items-center rounded-r-md px-2 text-sm'>
                  {columnMeta.unit}
                </span>
              )}
            </div>
          );

        case 'range':
          return <DataTableSliderFilter column={column} title={columnMeta.label ?? column.id} />;

        case 'date':
        case 'dateRange':
          return (
            <DataTableDateFilter
              column={column}
              title={columnMeta.label ?? column.id}
              multiple={columnMeta.variant === 'dateRange'}
            />
          );

        case 'select':
        case 'multiSelect':
          return (
            <DataTableFacetedFilter
              column={column}
              title={columnMeta.label ?? column.id}
              options={columnMeta.options ?? []}
              multiple={columnMeta.variant === 'multiSelect'}
            />
          );

        default:
          return null;
      }
    }, [column, columnMeta]);

    return onFilterRender();
  }
}
