import type { ColumnDef, Row } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import type { DataTableFeatures } from '@/lib/table-features';
import type { LedgerAccountDto } from '@/server/ledger-accounts-functions';
import { ledgerAccountTypeLabel } from '@/features/finance/constants';
import { AccountCellAction } from './book-accounts-cell-action';

export interface LedgerAccountTreeNode extends LedgerAccountDto {
  children: LedgerAccountTreeNode[];
}

/**
 * Nests accounts under their parent — same technique
 * `entities-table/columns.tsx`'s `buildEntityTree` uses: TanStack Table's own
 * `getSubRows`/`getExpandedRowModel` own the tree, indentation comes from
 * `row.depth`.
 */
export function buildAccountTree(accounts: LedgerAccountDto[]): LedgerAccountTreeNode[] {
  const ids = new Set(accounts.map((account) => account.id));
  const byId = new Map<string, LedgerAccountTreeNode>(
    accounts.map((account) => [account.id, { ...account, children: [] }])
  );
  const roots: LedgerAccountTreeNode[] = [];
  for (const account of accounts) {
    const node = byId.get(account.id);
    if (!node) continue;
    const parentKey =
      account.parentAccountId !== null && ids.has(account.parentAccountId)
        ? account.parentAccountId
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
 * No column here is sortable/filterable, same reasoning as
 * `entities-table/columns.tsx`: order is the chart hierarchy (parent
 * accounts before their children, by code within a level), not a
 * user-chosen sort.
 */
export function getAccountColumns(
  isAdmin: boolean,
  accountingBookId: string,
  onEdit: (account: LedgerAccountDto) => void
): ColumnDef<DataTableFeatures, LedgerAccountTreeNode>[] {
  const columns: ColumnDef<DataTableFeatures, LedgerAccountTreeNode>[] = [
    {
      id: 'code',
      accessorKey: 'code',
      header: 'Account',
      cell: ({ row }: { row: Row<DataTableFeatures, LedgerAccountTreeNode> }) => (
        <div className='flex items-center gap-2' style={{ paddingLeft: `${row.depth * 1.25}rem` }}>
          <span className='text-muted-foreground tabular-nums'>{row.original.code}</span>
          <span className={row.original.isPostable ? undefined : 'text-muted-foreground'}>
            {row.original.name}
          </span>
          {row.original.systemKey && (
            <Badge variant='outline' className='text-xs'>
              {row.original.systemKey}
            </Badge>
          )}
        </div>
      )
    },
    {
      id: 'accountType',
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant='outline'>{ledgerAccountTypeLabel(row.original.accountType)}</Badge>
      )
    },
    {
      id: 'accountSubtype',
      header: 'Subtype',
      cell: ({ row }) => (
        <span className='text-muted-foreground'>{row.original.accountSubtype ?? '—'}</span>
      )
    },
    {
      id: 'kind',
      header: 'Kind',
      cell: ({ row }) => (
        <div className='flex gap-1'>
          {!row.original.isPostable && <Badge variant='secondary'>Roll-up</Badge>}
          {row.original.isContra && <Badge variant='outline'>Contra</Badge>}
        </div>
      )
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'active' ? 'success' : 'outline'}>
          {row.original.status}
        </Badge>
      )
    }
  ];

  if (isAdmin) {
    columns.push({
      id: 'actions',
      cell: ({ row }) => (
        <AccountCellAction
          data={row.original}
          accountingBookId={accountingBookId}
          onEdit={onEdit}
        />
      )
    });
  }

  return columns;
}
