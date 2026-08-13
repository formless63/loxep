import { queryOptions } from '@tanstack/react-query';
import { fetchDocument, fetchDocumentQueue } from '@/server/documents-functions';

export const documentQueueQuery = queryOptions({
  queryKey: ['documents', 'queue'],
  queryFn: () => fetchDocumentQueue()
});

export const documentQuery = (id: string) =>
  queryOptions({
    queryKey: ['documents', 'document', id],
    queryFn: () => fetchDocument({ data: { id } }),
    enabled: id.length > 0
  });
