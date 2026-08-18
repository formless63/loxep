import { createFileRoute } from '@tanstack/react-router';
import { FinancePage } from '@/features/finance/components/finance-page';
import PartnersTable from '@/features/finance/components/partners-table';

export const Route = createFileRoute('/finance/partners')({
  component: FinancePartners
});

function FinancePartners() {
  return (
    <FinancePage
      title='Trading partners'
      description="Customers, vendors, and every other outside party Loxep does business with — never one of Loxep's own economic entities."
    >
      <PartnersTable />
    </FinancePage>
  );
}
