import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Icons } from '@/components/icons';
import { formatDateTime } from '@/lib/format';
import { documentQueueQuery } from '@/features/documents/api/queries';
import { documentStatusLabel, documentStatusTone } from '@/features/documents/constants';
import CsvImportWizard from './csv-import-wizard';
import ReceiptUploadPanel from './receipt-upload-panel';
import DocumentReviewPanel from './document-review-panel';

/**
 * `/finance/import` (loxep-dgf.4, M4): upload CSV/receipt -> mapping/review
 * screen -> confirm rows, per the design's ask 1 (CSV import) and 2b
 * (receipt review), sharing one staging table.
 */
export default function ImportPage() {
  const [activeDocumentId, setActiveDocumentId] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const trimmedSearch = search.trim();
  const { data: queue, isPending } = useQuery(documentQueueQuery(trimmedSearch));

  if (activeDocumentId) {
    return (
      <div className='space-y-4'>
        <Button variant='ghost' size='sm' onClick={() => setActiveDocumentId(null)}>
          <Icons.chevronLeft />
          Back to import
        </Button>
        <DocumentReviewPanel documentId={activeDocumentId} />
      </div>
    );
  }

  return (
    <div className='space-y-8'>
      <Tabs defaultValue='csv'>
        <TabsList>
          <TabsTrigger value='csv'>CSV import</TabsTrigger>
          <TabsTrigger value='receipt'>Receipt / invoice</TabsTrigger>
        </TabsList>
        <TabsContent value='csv' className='pt-4'>
          <CsvImportWizard onStaged={setActiveDocumentId} />
        </TabsContent>
        <TabsContent value='receipt' className='pt-4'>
          <ReceiptUploadPanel onUploaded={setActiveDocumentId} />
        </TabsContent>
      </Tabs>

      <div className='space-y-3'>
        <div className='flex flex-wrap items-center justify-between gap-3'>
          <h2 className='text-lg font-semibold'>Awaiting review</h2>
          <div className='relative w-full max-w-xs'>
            <Icons.search
              className='text-muted-foreground/70 pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2'
              aria-hidden='true'
            />
            <Input
              type='search'
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder='Search receipt text (e.g. a brand, model, or store name)'
              className='pl-9'
              aria-label='Search receipt text'
            />
          </div>
        </div>
        {trimmedSearch.length > 0 ? (
          <p className='text-muted-foreground text-xs'>
            Searching extracted receipt/invoice text. Only documents processed since text extraction
            was enabled on this installation are searchable — an older or unprocessed document will
            not match even if the phrase is on the page.
          </p>
        ) : null}
        {isPending ? (
          <Skeleton className='h-24 w-full' />
        ) : queue && queue.length > 0 ? (
          <div className='divide-y rounded-md border'>
            {queue.map((document) => (
              <button
                key={document.id}
                type='button'
                onClick={() => setActiveDocumentId(document.id)}
                className='hover:bg-accent flex w-full items-center justify-between gap-4 p-3 text-left text-sm'
              >
                <span className='flex items-center gap-2'>
                  <Icons.fees className='text-muted-foreground' />
                  {document.originalFilename ?? `${document.documentKind} import`}
                  <Badge variant={documentStatusTone(document.status)}>
                    {documentStatusLabel(document.status)}
                  </Badge>
                </span>
                <span className='text-muted-foreground'>
                  {document.confirmedCount}/{document.lineCount} confirmed ·{' '}
                  {formatDateTime(document.createdAt)}
                </span>
              </button>
            ))}
          </div>
        ) : trimmedSearch.length > 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.search />
              </EmptyMedia>
              <EmptyTitle>No matches for &ldquo;{trimmedSearch}&rdquo;</EmptyTitle>
              <EmptyDescription>
                No document awaiting review has extracted text matching that search. This does not
                mean the phrase is absent from a receipt — only processed documents are searchable
                (see the note above).
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <Icons.checks />
              </EmptyMedia>
              <EmptyTitle>Nothing awaiting review</EmptyTitle>
              <EmptyDescription>
                Import a CSV or upload a receipt above to start a review batch.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}
