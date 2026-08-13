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
  const { data: queue, isPending } = useQuery(documentQueueQuery);

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
        <h2 className='text-lg font-semibold'>Awaiting review</h2>
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
