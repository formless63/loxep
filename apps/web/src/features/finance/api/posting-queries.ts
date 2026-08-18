import { queryOptions } from '@tanstack/react-query';
import {
  explainSourceFact,
  fetchPostingBacklog,
  fetchPostingRules
} from '@/server/posting-functions';

export const postingBacklogQuery = queryOptions({
  queryKey: ['finance', 'posting', 'backlog'],
  queryFn: () => fetchPostingBacklog()
});

export const postingRulesQuery = queryOptions({
  queryKey: ['finance', 'posting', 'rules'],
  queryFn: () => fetchPostingRules()
});

export const explainSourceFactQuery = (sourceFactType: string, sourceFactId: string) =>
  queryOptions({
    queryKey: ['finance', 'posting', 'explain', sourceFactType, sourceFactId],
    queryFn: () => explainSourceFact({ data: { sourceFactType, sourceFactId } })
  });
