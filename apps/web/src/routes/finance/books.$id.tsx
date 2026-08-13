import { createFileRoute, Link } from '@tanstack/react-router';
import { Icons } from '@/components/icons';
import { FinancePage } from '@/features/finance/components/finance-page';
import BookDetail from '@/features/finance/components/book-detail';

export const Route = createFileRoute('/finance/books/$id')({
  component: FinanceBookDetail
});

function FinanceBookDetail() {
  const { id } = Route.useParams();

  return (
    <FinancePage
      title='Book'
      description='Entity links, fiscal periods, and the trial balance for this book.'
      actions={
        <Link to='/finance/books' className='text-muted-foreground text-sm hover:underline'>
          <Icons.arrowRight className='mr-1 inline-block rotate-180 align-text-bottom' />
          Back to books
        </Link>
      }
    >
      <BookDetail bookId={id} />
    </FinancePage>
  );
}
