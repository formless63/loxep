import { queryOptions } from '@tanstack/react-query';
import { fetchDocument, fetchDocumentQueue } from '@/server/documents-functions';

/** `q` (trimmed, empty treated as "no search") searches `documents.parsed_text_tsv` — see `fetchDocumentQueue`'s own doc. */
export const documentQueueQuery = (q?: string) => {
  const trimmed = q?.trim() ?? '';
  return queryOptions({
    queryKey: ['documents', 'queue', trimmed],
    queryFn: () => fetchDocumentQueue({ data: { q: trimmed.length > 0 ? trimmed : null } })
  });
};

export const documentQuery = (id: string) =>
  queryOptions({
    queryKey: ['documents', 'document', id],
    queryFn: () => fetchDocument({ data: { id } }),
    enabled: id.length > 0
  });
