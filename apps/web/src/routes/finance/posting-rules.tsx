import { createFileRoute } from '@tanstack/react-router';
import { FinancePage } from '@/features/finance/components/finance-page';
import PostingRulesTable from '@/features/finance/components/posting-rules-table';

export const Route = createFileRoute('/finance/posting-rules')({
  component: FinancePostingRules
});

/**
 * Read-only posting-rule list (loxep-6ea, audit finding A3) — the answer to
 * "why did this post to Suspense?" that the audit named. Rule authoring
 * (create/edit/activate/disable) is out of this bead's scope; every rule
 * shown here is whatever `seedDefaultRules` wrote or an operator configured
 * directly against the database.
 */
function FinancePostingRules() {
  return (
    <FinancePage
      title='Posting rules'
      description='Every rule the posting engine evaluates, in priority order, with its match criteria and target accounts.'
    >
      <PostingRulesTable />
    </FinancePage>
  );
}
