import type { InventoryProfitabilityDto } from '@/server/inventory-functions';
import { ContributionBanner } from './contribution-note';
import AcquisitionRoiTable from './acquisition-roi-table';
import SourcingChannelTable from './sourcing-channel-table';
import OnHandAtCostTable from './on-hand-at-cost-table';
import InventoryAgingChart from './aging-chart';
import OversellsWorklist from './oversells-worklist';
import UnmatchedDepletionsWorklist from './unmatched-depletions-worklist';
import UnlinkedShippingLabelFeesWorklist from './unlinked-shipping-label-fees-worklist';

export { default as ProfitabilitySkeleton } from './profitability-skeleton';

/**
 * `/inventory/profitability` (loxep-7fs, A11) — mounts the six
 * `@loxep/inventory/profitability.ts` read models this milestone surfaces:
 * ROI per acquisition, sourcing-channel performance, on-hand-at-cost +
 * aging, and the two integrity worklists (oversells, unmatched depletions).
 * "This is the entire 'did flipping make money' question" — the audit's own
 * words for why these ten functions shipping with zero callers mattered.
 * Also carries `ShipmentsService.unlinkedShippingLabelFees` (A14) — a third
 * integrity worklist for the shipping double-count guard, folded into the
 * same combined DTO.
 *
 * `itemRealizedContribution`/`orderRealizedContribution` (per-line/per-order
 * granularity under the acquisition roll-up here) and `openLots`/
 * `costReconciliation` (lot cost-hygiene worklists) remain unwired — see
 * this pass's report.
 */
export default function ProfitabilityContent({ data }: { data: InventoryProfitabilityDto }) {
  return (
    <div className='flex flex-col gap-4'>
      <ContributionBanner label={data.contributionLabel} />
      <AcquisitionRoiTable rows={data.acquisitionRoi} contributionLabel={data.contributionLabel} />
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <SourcingChannelTable
          rows={data.sourcingChannelPerformance}
          contributionLabel={data.contributionLabel}
        />
        <OnHandAtCostTable rows={data.onHandAtCost} />
      </div>
      <InventoryAgingChart rows={data.aging} />
      <div className='grid grid-cols-1 gap-4 lg:grid-cols-2'>
        <OversellsWorklist rows={data.oversells} />
        <UnmatchedDepletionsWorklist rows={data.unmatchedDepletions} />
      </div>
      <UnlinkedShippingLabelFeesWorklist rows={data.unlinkedShippingLabelFees} />
    </div>
  );
}
