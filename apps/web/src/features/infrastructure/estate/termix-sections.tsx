import TermixHostsSection from '@/features/infrastructure/components/termix-estate/hosts-section';
import TermixSessionsSection from '@/features/infrastructure/components/termix-estate/sessions-section';

/**
 * The Termix estate browser's (loxep-47o.7) sections, mounted through the
 * estate shell's provider→sections registry. Hosts + Sessions, both
 * instance-wide (Estate Browsers Design §3.8; Sessions per the owner's 5b
 * ruling, 2026-08-16 — see `termix-estate-functions.ts`'s module doc).
 */
export default function TermixEstateSections({ connectionId }: { connectionId: string }) {
  return (
    <div className='flex flex-col gap-4'>
      <TermixHostsSection connectionId={connectionId} />
      <TermixSessionsSection connectionId={connectionId} />
    </div>
  );
}
