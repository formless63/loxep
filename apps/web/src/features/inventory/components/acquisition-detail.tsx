import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';
import { toastError } from '@/lib/errors';
import { formatDate, formatDateTime, formatMoney, formatQuantity, formatScore } from '@/lib/format';
import { acquisitionQuery } from '@/features/inventory/api/queries';
import { QueryErrorAlert } from '@/features/settings/components/query-error-alert';
import { allocateAcquisitionCosts } from '@/server/inventory-functions';
import {
  acquisitionSourceKindLabel,
  acquisitionStatusLabel,
  acquisitionStatusTone,
  costAllocationBasisLabel,
  costAllocationBasisOptions,
  costAllocationStatusLabel,
  costAllocationStatusTone,
  itemStatusLabel,
  itemStatusTone,
  type CostAllocationBasis
} from '@/features/inventory/constants';

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex flex-col gap-0.5'>
      <span className='text-muted-foreground text-xs'>{label}</span>
      <span className='text-sm'>{children}</span>
    </div>
  );
}

/**
 * Basis picker + "Allocate costs" — the UI half of loxep-dgf.2's acceptance
 * criterion. The engine itself (largest-remainder allocation, the negative-
 * pool refusal) lives in `@loxep/inventory/acquisitions.ts`'s `allocateCosts`,
 * which this workspace cannot reach yet (see `inventory-functions.ts`'s top
 * doc) — the mutation is real and wired, and today it surfaces that gap
 * through the same error-toast path a real refusal would use once wired.
 */
function CostAllocationPanel({ acquisitionId }: { acquisitionId: string }) {
  const [basis, setBasis] = React.useState<CostAllocationBasis>('relative_value');
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => allocateAcquisitionCosts({ data: { acquisitionId, basis } }),
    onSuccess: () => {
      toast.success('Costs allocated');
      void queryClient.invalidateQueries({ queryKey: ['inventory'] });
    },
    onError: (error) => toastError(error, 'Could not allocate costs')
  });

  return (
    <div className='flex flex-wrap items-end gap-3'>
      <Field className='w-56'>
        <FieldLabel htmlFor='cost-allocation-basis'>Allocation basis</FieldLabel>
        <Select value={basis} onValueChange={(value) => setBasis(value as CostAllocationBasis)}>
          <SelectTrigger id='cost-allocation-basis'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {costAllocationBasisOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Button size='sm' disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        <Icons.adjustments />
        Allocate costs
      </Button>
    </div>
  );
}

export default function AcquisitionDetail({ acquisitionId }: { acquisitionId: string }) {
  const { data, isPending, isError, error, refetch } = useQuery(acquisitionQuery(acquisitionId));

  if (isPending) {
    return <div className='text-muted-foreground text-sm'>Loading…</div>;
  }

  if (isError) {
    return (
      <QueryErrorAlert error={error} title='Could not load acquisition' onRetry={() => refetch()} />
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      <Card>
        <CardHeader>
          <CardTitle className='flex items-center gap-2 text-xl'>
            {data.referenceCode}
            <Badge variant={acquisitionStatusTone(data.status)}>
              {acquisitionStatusLabel(data.status)}
            </Badge>
            <Badge variant={costAllocationStatusTone(data.costAllocationStatus)}>
              costs {costAllocationStatusLabel(data.costAllocationStatus)}
            </Badge>
            {data.connectionId !== null && (
              <Badge
                variant='secondary'
                title='Ingested from a connected account (e.g. eBay purchase history); review its costs before allocating'
              >
                Imported — needs review
              </Badge>
            )}
          </CardTitle>
          <p className='text-muted-foreground text-sm'>{data.title}</p>
        </CardHeader>
        <CardContent className='grid grid-cols-2 gap-4 sm:grid-cols-4'>
          <DetailRow label='Source'>{acquisitionSourceKindLabel(data.sourceKind)}</DetailRow>
          <DetailRow label='Vendor'>
            {data.vendorName ?? '—'}
            {data.vendorLocation && (
              <span className='text-muted-foreground'> · {data.vendorLocation}</span>
            )}
          </DetailRow>
          <DetailRow label='Items'>{data.itemCount}</DetailRow>
          <DetailRow label='Allocation basis'>
            {costAllocationBasisLabel(data.costAllocationBasis)}
          </DetailRow>
          <DetailRow label='Acquired'>{formatDate(data.acquiredAt)}</DetailRow>
          <DetailRow label='Received'>
            {data.receivedAt ? formatDate(data.receivedAt) : '—'}
          </DetailRow>
          <DetailRow label='Expected items'>{data.expectedItemCount ?? '—'}</DetailRow>
          {data.externalReference &&
            (/^https?:\/\//.test(data.externalReference) ? (
              <DetailRow label='Reference'>
                <a
                  href={data.externalReference}
                  target='_blank'
                  rel='noreferrer'
                  className='inline-flex items-center gap-1 text-primary hover:underline'
                >
                  {data.externalReference}
                  <Icons.externalLink className='h-3 w-3' />
                </a>
              </DetailRow>
            ) : (
              // A connector-ingested reference (e.g. an eBay order id, loxep-dgf.5)
              // is an opaque provider identifier, not a URL — rendering it as a
              // link would produce a broken/misleading href.
              <DetailRow label='Reference'>
                <span className='font-mono'>{data.externalReference}</span>
              </DetailRow>
            ))}
          {data.notes && <DetailRow label='Notes'>{data.notes}</DetailRow>}
        </CardContent>
      </Card>

      {data.sourcedFrom.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Sourced from /market</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            {data.sourcedFrom.map((link) => (
              <div key={link.id} className='flex flex-wrap items-center gap-2 text-sm'>
                <Badge variant='secondary'>{link.linkKind.replace(/_/g, ' ')}</Badge>
                {link.marketplaceItemId ? (
                  <Link
                    to='/market/items/$itemId'
                    params={{ itemId: link.marketplaceItemId }}
                    className='hover:underline'
                  >
                    View the watched item
                  </Link>
                ) : (
                  <span className='text-muted-foreground'>—</span>
                )}
                {link.scoreAtLink && (
                  <span className='text-muted-foreground'>
                    score {formatScore(Number(link.scoreAtLink))} at link time
                  </span>
                )}
                <span className='text-muted-foreground text-xs'>
                  {formatDateTime(link.linkedAt)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Landed cost, by currency</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          {data.landedCost.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No costs entered yet.</p>
          ) : (
            <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
              {data.landedCost.map((group) => (
                <div key={group.currency} className='rounded-md border p-3'>
                  <p className='text-muted-foreground text-xs'>{group.currency}</p>
                  <div className='mt-1 grid grid-cols-2 gap-2 text-sm'>
                    <DetailRow label='Goods'>
                      {formatMoney(group.goodsAmount, group.currency)}
                    </DetailRow>
                    <DetailRow label='Ancillary'>
                      {formatMoney(group.ancillaryAmount, group.currency)}
                    </DetailRow>
                    <DetailRow label='Landed (capitalized)'>
                      {formatMoney(group.landedCostAmount, group.currency)}
                    </DetailRow>
                    {/* Non-capitalized real spend, shown SEPARATELY and labelled — never folded into landed cost (Phase 4 OQ10). */}
                    <DetailRow label='Not capitalized'>
                      {formatMoney(group.nonCapitalizedAmount, group.currency)}
                      <span className='text-muted-foreground'>
                        {' '}
                        (real spend, excluded from basis)
                      </span>
                    </DetailRow>
                  </div>
                </div>
              ))}
            </div>
          )}
          <CostAllocationPanel acquisitionId={acquisitionId} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Cost components</CardTitle>
        </CardHeader>
        <CardContent>
          {data.costs.length === 0 ? (
            <p className='text-muted-foreground text-sm'>No cost components recorded yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Class</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead className='text-right'>Amount</TableHead>
                  <TableHead>Capitalized</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.costs.map((cost) => (
                  <TableRow key={cost.id}>
                    <TableCell>{cost.costType}</TableCell>
                    <TableCell className='text-muted-foreground'>{cost.costClass}</TableCell>
                    <TableCell className='text-muted-foreground'>{cost.costScope}</TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatMoney(cost.amount, cost.currency)}
                    </TableCell>
                    <TableCell>
                      {cost.capitalize ? (
                        <Badge variant='secondary'>Capitalized</Badge>
                      ) : (
                        <Badge variant='outline'>Not capitalized</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {data.linkedExpenses.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Linked expenses</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-2'>
            <p className='text-muted-foreground text-sm'>
              Costs on this lot that were also recorded as a `/finance` expense — the acquisition
              seam, the reverse of the note on an expense's detail page.
            </p>
            {data.linkedExpenses.map((expense) => (
              <div key={expense.expenseId} className='flex flex-wrap items-center gap-2 text-sm'>
                <Link
                  to='/finance/expenses/$id'
                  params={{ id: expense.expenseId }}
                  className='hover:underline'
                >
                  {expense.referenceCode}
                </Link>
                <Badge variant='outline'>{expense.category}</Badge>
                <span className='tabular-nums'>
                  {formatMoney(expense.amount, expense.currency)}
                </span>
                <span className='text-muted-foreground'>{formatDate(expense.expenseDate)}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>Items in this lot</CardTitle>
        </CardHeader>
        <CardContent>
          {data.items.length === 0 ? (
            <p className='text-muted-foreground text-sm'>
              Nothing unpacked yet — add items to this lot from the intake review queue.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className='text-right'>Qty on hand</TableHead>
                  <TableHead className='text-right'>Landed cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        to='/inventory/stock/$id'
                        params={{ id: item.id }}
                        className='hover:underline'
                      >
                        {item.itemCode}
                      </Link>
                      <span className='text-muted-foreground ml-2'>{item.label}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={itemStatusTone(item.status)}>
                        {itemStatusLabel(item.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatQuantity(Number(item.quantityOnHand))}
                    </TableCell>
                    <TableCell className='text-right tabular-nums'>
                      {formatMoney(item.landedCostAmount, item.currency)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
