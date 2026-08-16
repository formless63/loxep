import * as React from 'react';
import InvoiceNinjaClientsSection from '@/features/finance/estate/components/clients-section';
import InvoiceNinjaClientDetailPanel from '@/features/finance/estate/components/client-detail-panel';
import InvoiceNinjaInvoicesSection from '@/features/finance/estate/components/invoices-section';
import InvoiceNinjaInvoiceDetailPanel from '@/features/finance/estate/components/invoice-detail-panel';
import type {
  InvoiceNinjaEstateClientDto,
  InvoiceNinjaEstateInvoiceDto
} from '@/server/invoiceninja-estate-functions';

/**
 * The Invoice Ninja estate browser's (loxep-47o.8) sections, mounted through
 * the FIRST estate-shell provider→sections registry built outside
 * `/infrastructure` (`features/finance/estate/section-registry.tsx`) — proof
 * of Rule P1's workspace parameter. Clients + Invoices is the fixed two-call
 * overview (Estate Browsers Design §3.9). Each has its OWN master-detail
 * drill-in state, ONE row at a time (Rule P6) — exactly
 * `cloudflare-sections.tsx`'s zones/records shape, generalized to two
 * independent sections rather than one master feeding one detail.
 *
 * ZERO write affordances anywhere in this module or anything it imports —
 * see `invoiceninja-estate-functions.ts`'s own doc for the full accounting
 * of what is deliberately never imported.
 */
export default function InvoiceNinjaEstateSections({ connectionId }: { connectionId: string }) {
  const [selectedClient, setSelectedClient] = React.useState<InvoiceNinjaEstateClientDto | null>(
    null
  );
  const [selectedInvoice, setSelectedInvoice] = React.useState<InvoiceNinjaEstateInvoiceDto | null>(
    null
  );

  return (
    <div className='flex flex-col gap-4'>
      <InvoiceNinjaClientsSection
        connectionId={connectionId}
        selectedClientId={selectedClient?.externalClientId ?? null}
        onViewDetail={(client) =>
          setSelectedClient((current) =>
            current?.externalClientId === client.externalClientId ? null : client
          )
        }
      />
      {selectedClient !== null && (
        <InvoiceNinjaClientDetailPanel
          connectionId={connectionId}
          externalClientId={selectedClient.externalClientId}
        />
      )}
      <InvoiceNinjaInvoicesSection
        connectionId={connectionId}
        selectedInvoiceId={selectedInvoice?.externalInvoiceId ?? null}
        onViewDetail={(invoice) =>
          setSelectedInvoice((current) =>
            current?.externalInvoiceId === invoice.externalInvoiceId ? null : invoice
          )
        }
      />
      {selectedInvoice !== null && (
        <InvoiceNinjaInvoiceDetailPanel
          connectionId={connectionId}
          externalInvoiceId={selectedInvoice.externalInvoiceId}
        />
      )}
    </div>
  );
}
