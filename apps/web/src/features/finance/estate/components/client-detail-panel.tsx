import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { formatMoney, formatRelativeTime } from '@/lib/format';
import { EstateSection } from '@/features/estate/components/estate-section';
import { invoiceNinjaEstateClientDetailQuery } from '@/features/finance/estate/api/queries';

/**
 * The Invoice Ninja estate's per-client DRILL-IN (Rule P6) — `fetchClient`,
 * fired only once an operator expands one client row. Adds `contacts[]`,
 * which the Clients overview row deliberately omits to keep that table
 * compact (`invoiceninja-estate-functions.ts`'s own doc). Read-only: no edit
 * affordance of any kind.
 */
export default function InvoiceNinjaClientDetailPanel({
  connectionId,
  externalClientId
}: {
  connectionId: string;
  externalClientId: string;
}) {
  const { data, isPending, isError, error, refetch } = useQuery(
    invoiceNinjaEstateClientDetailQuery(connectionId, externalClientId)
  );

  return (
    <EstateSection
      title='Client detail'
      description="Live from Invoice Ninja's fetchClient for this one client."
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
              <div className='text-muted-foreground text-xs'>Name</div>
              <div>{value.displayName || value.name}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>ID number</div>
              <div>{value.idNumber ?? '—'}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>VAT number</div>
              <div>{value.vatNumber ?? '—'}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Balance</div>
              <div>{formatMoney(value.balance, null)}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Paid to date</div>
              <div>{formatMoney(value.paidToDate, null)}</div>
            </div>
            <div>
              <div className='text-muted-foreground text-xs'>Updated</div>
              <div>{value.updatedAt === null ? '—' : formatRelativeTime(value.updatedAt)}</div>
            </div>
          </div>
          {value.isDeleted && <Badge variant='destructive'>Deleted on Invoice Ninja</Badge>}
          <div>
            <div className='text-muted-foreground mb-1 text-xs'>Contacts</div>
            {value.contacts.length === 0 ? (
              <p className='text-muted-foreground'>No contacts on this client.</p>
            ) : (
              <ul className='flex flex-col gap-1'>
                {value.contacts.map((contact) => (
                  <li key={contact.externalContactId} className='flex items-center gap-2'>
                    <span>
                      {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—'}
                    </span>
                    {contact.email !== null && (
                      <span className='text-muted-foreground text-xs'>{contact.email}</span>
                    )}
                    {contact.isPrimary && <Badge variant='secondary'>Primary</Badge>}
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
