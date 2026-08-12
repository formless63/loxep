import { type Table as TanstackTable, flexRender } from '@tanstack/react-table';
import type * as React from 'react';

import { DataTablePagination } from '@/components/ui/table/data-table-pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { getCommonPinningStyles } from '@/lib/data-table';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

interface DataTableProps<TData> extends React.ComponentProps<'div'> {
  table: TanstackTable<TData>;
  actionBar?: React.ReactNode;
}

export function DataTable<TData>({ table, actionBar, children }: DataTableProps<TData>) {
  return (
    <div className='flex flex-1 flex-col space-y-4'>
      {children}
      {/* The absolute/inset scroll trick needs an ancestor height chain; inside
          an unsized container (e.g. CardContent) flex-1 computes to zero and the
          rows become invisible. min-h guarantees a usable row area everywhere;
          full-height page layouts already exceed it and are unaffected. */}
      <div className='relative flex min-h-[320px] flex-1'>
        <div className='absolute inset-0 flex overflow-hidden rounded-lg border'>
          <ScrollArea className='h-full w-full'>
            <Table>
              <TableHeader className='bg-muted sticky top-0 z-10'>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        style={{
                          ...getCommonPinningStyles({ column: header.column })
                        }}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows?.length ? (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          style={{
                            ...getCommonPinningStyles({ column: cell.column })
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={table.getAllColumns().length} className='h-24 text-center'>
                      {table.getState().columnFilters.length > 0
                        ? 'No results match your filters.'
                        : 'No data to display yet.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            <ScrollBar orientation='horizontal' />
          </ScrollArea>
        </div>
      </div>
      <div className='flex flex-col gap-2.5'>
        <DataTablePagination table={table} />
        {actionBar && table.getFilteredSelectedRowModel().rows.length > 0 && actionBar}
      </div>
    </div>
  );
}
