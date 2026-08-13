import { createFileRoute } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { FinancePage } from '@/features/finance/components/finance-page';
import ImportPage from '@/features/documents/components/import-page';

/**
 * `page`/`perPage`/`sort` back `CandidatesTable`'s `useDataTable` once a
 * document is under review — see `useDataTable`, which keys pagination and
 * sorting into whatever route it is mounted under.
 */
const importSearchSchema = z.object({
  page: z.number().optional().default(1),
  perPage: z.number().optional().default(50),
  sort: z.string().optional()
});

export const Route = createFileRoute('/finance/import')({
  validateSearch: zodValidator(importSearchSchema),
  component: FinanceImport
});

function FinanceImport() {
  return (
    <FinancePage
      title='Import'
      description='Upload a CSV of card/bank activity or a receipt photo, review the suggested lines, and confirm them into expenses. The parser proposes — it never auto-commits.'
    >
      <ImportPage />
    </FinancePage>
  );
}
