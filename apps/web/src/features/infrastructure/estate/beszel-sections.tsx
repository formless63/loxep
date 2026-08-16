import BeszelHubPanel from '@/features/infrastructure/components/beszel-estate/hub-panel';
import BeszelSystemsSection from '@/features/infrastructure/components/beszel-estate/systems-section';

/**
 * The Beszel estate browser's (loxep-47o.7) sections, mounted through the
 * estate shell's provider→sections registry. Hub + Systems is the fixed
 * two-call overview (Estate Browsers Design §3.5).
 */
export default function BeszelEstateSections({ connectionId }: { connectionId: string }) {
  return (
    <div className='flex flex-col gap-4'>
      <BeszelHubPanel connectionId={connectionId} />
      <BeszelSystemsSection connectionId={connectionId} />
    </div>
  );
}
