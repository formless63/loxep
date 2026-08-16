import PurelymailAccountFactsPanel from '@/features/infrastructure/components/purelymail-estate/account-facts-panel';
import PurelymailDomainsSection from '@/features/infrastructure/components/purelymail-estate/domains-section';
import PurelymailMailboxesSection from '@/features/infrastructure/components/purelymail-estate/mailboxes-section';
import PurelymailRoutingRulesSection from '@/features/infrastructure/components/purelymail-estate/routing-rules-section';

/**
 * The Purelymail estate browser's (loxep-47o.3) sections, mounted through
 * the estate shell's provider→sections registry
 * (`features/infrastructure/estate/section-registry.tsx`) — the same
 * per-section, non-suspense `useQuery` shape `cloudflare-sections.tsx`
 * establishes. Domains + Mailboxes + Routing rules is the fixed three-call
 * overview (Rule P7); account facts fold into their own drill-in panel,
 * fetched only on explicit expand.
 */
export default function PurelymailEstateSections({ connectionId }: { connectionId: string }) {
  return (
    <div className='flex flex-col gap-4'>
      <PurelymailAccountFactsPanel connectionId={connectionId} />
      <PurelymailDomainsSection connectionId={connectionId} />
      <PurelymailMailboxesSection connectionId={connectionId} />
      <PurelymailRoutingRulesSection connectionId={connectionId} />
    </div>
  );
}
