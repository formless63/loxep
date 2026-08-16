import TailscaleDevicesSection from '@/features/infrastructure/components/tailscale-estate/devices-section';

/**
 * The Tailscale estate browser's (loxep-47o.6) sections, mounted through the
 * estate shell's provider→sections registry
 * (`features/infrastructure/estate/section-registry.tsx`). One section: the
 * whole tailnet in one call (Estate Browsers Design §3.6).
 */
export default function TailscaleEstateSections({ connectionId }: { connectionId: string }) {
  return (
    <div className='flex flex-col gap-4'>
      <TailscaleDevicesSection connectionId={connectionId} />
    </div>
  );
}
