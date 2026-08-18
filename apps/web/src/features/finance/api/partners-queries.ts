import { queryOptions } from '@tanstack/react-query';
import { fetchPartners } from '@/server/partners-functions';

export const partnersQuery = queryOptions({
  queryKey: ['finance', 'partners'],
  queryFn: () => fetchPartners()
});
