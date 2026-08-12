import { QueryClient } from '@tanstack/react-query';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000
      }
    }
  });
}

// In the browser there is one QueryClient for the life of the page, so
// mutation options defined outside components can reach it for invalidation.
// On the server a QueryClient must be request-scoped: sharing one across SSR
// requests leaks the query-cache subscribers the router-ssr-query integration
// registers per request, which corrupts later requests' dehydration streams
// (loxep-gb0). createRouter() runs once per request and owns the instance.
let browserQueryClient: QueryClient | undefined;

export function getQueryClient() {
  if (typeof window === 'undefined') {
    return createQueryClient();
  }
  browserQueryClient ??= createQueryClient();
  return browserQueryClient;
}
