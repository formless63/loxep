import { type ReactTable, type RowData, flexRender } from '@tanstack/react-table';
import type * as React from 'react';

import { DataTablePagination } from '@/components/ui/table/data-table-pagination';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { getCommonPinningStyles } from '@/lib/data-table';
import type { DataTableFeatures } from '@/lib/table-features';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';

interface DataTableProps<TData extends RowData> extends React.ComponentProps<'div'> {
  table: ReactTable<DataTableFeatures, TData>;
  actionBar?: React.ReactNode;
  /**
   * Optional totals/summary row(s), rendered inside a `<TableFooter>` right
   * after `<TableBody>` — the sanctioned path for a balances-to-zero row, a
   * per-currency totals row, or per-direction fee subtotals (Frontend
   * Standards, "Tables"). Pass `<TableRow>`/`<TableCell>` markup shaped like
   * one more body row (same column count/alignment); `TableFooter` already
   * carries `border-t bg-muted/50 font-medium` so a summary row reads as a
   * total without extra styling at the call site.
   *
   * Sticky-bottom, mirroring the header's `sticky top-0 z-10`: this only
   * works because the ScrollArea `Viewport` above is the one scrolling
   * ancestor (the donor `Table`'s own `overflow-x-auto` wrapper is
   * neutralized by the `[&_[data-slot=table-container]]:overflow-x-visible`
   * override on that same ScrollArea) — `position: sticky` resolves against
   * its nearest scrolling ancestor, which is this Viewport for both the
   * header and the footer. A solid `bg-muted` (not the default `/50`) keeps
   * scrolled-past body rows from showing through while the footer is pinned.
   */
  summary?: React.ReactNode;
}

export function DataTable<TData extends RowData>({
  table,
  actionBar,
  summary,
  children
}: DataTableProps<TData>) {
  return (
    <div className='flex flex-1 flex-col space-y-4'>
      {children}
      {/* The absolute/inset scroll trick needs an ancestor height chain; inside
          an unsized container (e.g. CardContent) flex-1 computes to zero and the
          rows become invisible. min-h guarantees a usable row area everywhere;
          full-height page layouts already exceed it and are unaffected. */}
      <div className='relative flex min-h-[320px] flex-1'>
        <div className='absolute inset-0 flex overflow-hidden rounded-lg border'>
          {/* The donor Table primitive wraps itself in an overflow-x-auto
              container. Inside this ScrollArea that made TWO nested
              horizontal scrollers, and position:sticky column pinning only
              counteracts its NEAREST scrolling ancestor — so pinned columns
              (mobile first-column pin, desktop actions pin) slid along with
              the outer, user-visible scroller (loxep-0g4 W5's finding). The
              descendant override collapses the inner scroller so this
              ScrollArea's viewport is the one scroll ancestor sticky cells
              position against. */}
          <ScrollArea className='h-full w-full [&_[data-slot=table-container]]:overflow-x-visible'>
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
                      {table.state.columnFilters.length > 0
                        ? 'No results match your filters.'
                        : 'No data to display yet.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
              {summary && (
                <TableFooter className='sticky bottom-0 z-10 bg-muted'>{summary}</TableFooter>
              )}
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
