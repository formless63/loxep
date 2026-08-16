import { queryOptions } from '@tanstack/react-query';
import { fetchEstateConnectionSummary } from '@/server/estate-functions';

/**
 * The estate-shell's connection-header read (loxep-47o.1). Live,
 * request-scoped — same "never a long `staleTime`" discipline every estate
 * read follows (Rule P5), since the connection's health/write-policy tier
 * can change between one render and the next.
 */
export const estateConnectionSummaryQuery = (connectionId: string) =>
  queryOptions({
    queryKey: ['estate', connectionId, 'summary'],
    queryFn: () => fetchEstateConnectionSummary({ data: { connectionId } })
  });
