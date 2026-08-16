import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { formatMoney } from '@/lib/format';
import { EstateSection } from '@/features/estate/components/estate-section';
import { invoiceNinjaEstateInvoiceDetailQuery } from '@/features/finance/estate/api/queries';

/**
 * The Invoice Ninja estate's per-invoice DRILL-IN (Rule P6) — `fetchInvoice`,
 * fired only once an operator expands one invoice row. Adds `lineItems[]`,
 * which the Invoices overview row deliberately omits
 * (`invoiceninja-estate-functions.ts`'s own doc). This is a LIVE, read-only
 * render of the provider's own line items — never a sync into Loxep's own
 * domain model (the design's "no pulling invoice lines back once issued" —
 * see §3.9's "Permanently read-only here"). Read-only: no edit affordance of
 * any kind.
 */
export default function InvoiceNinjaInvoiceDetailPanel({
  connectionId,
  externalInvoiceId
}: {
  connectionId: string;
  externalInvoiceId: string;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(
    invoiceNinjaEstateInvoiceDetailQuery(connectionId, externalInvoiceId)
  );

  return (
    <EstateSection
      title='Invoice detail'
      description="Live from Invoice Ninja's fetchInvoice for this one invoice."
      isPending={isPending}
      isError={isError}
      error={error}
      onRetry={() => refetch()}
      result={data}
      isEmpty={() => false}
      emptyMessage=''
      children={(value) => (
        <div className='flex flex-col gap-3 text-sm'>
          <div className='grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3'>
            <div>
              <div className='text-muted-foreground text-xs'>Number</div>
              <div>{value.number ?? '(draft — unnumbered)'}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Amount</div>
              <div>{formatMoney(value.amount, null)}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Balance</div>
              <div>{formatMoney(value.balance, null)}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Issued</div>
              <div>{value.issueOn ?? '—'}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Due</div>
              <div>{value.dueOn ?? '—'}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>PO number</div>
              <div>{value.poNumber ?? '—'}</div>
            </div>
          </div>
          {value.isDeleted && <Badge variant='destructive'>Deleted on Invoice Ninja</Badge>}
          <div>
            <div className='text-muted-foreground mb-1 text-xs'>Line items</div>
            {value.lineItems.length === 0 ? (
              <p className='text-muted-foreground'>No line items on this invoice.</p>
            ) : (
              <ul className='flex flex-col gap-1'>
                {value.lineItems.map((line, index) => (
                  // Invoice Ninja line items carry no id of their own on the
                  // wire; index is stable within one live, non-persisted read.
                  <li key={index} className='flex items-center justify-between gap-2'>
                    <span>{line.notes ?? line.productKey ?? '(no description)'}</span>
                    <span className='text-muted-foreground text-xs'>
                      {line.quantity} × {formatMoney(line.cost, null)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    />
  );
}
