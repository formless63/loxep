import * as React from 'react';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import type { PinnedPagePreferenceEntry } from '@loxep/domain';
import { Icons } from '@/components/icons';
import { fetchPinnedPages, savePinnedPages } from '@/server/preferences-functions';
import type { NavItem } from '@/types';
import type { WorkspaceId } from '@/config/workspaces';

/**
 * A user-pinned page for the /dashboard launchpad (loxep-koj, made durable by
 * loxep-lbj).
 *
 * Server-backed via `dashboard.pinned_pages` (`@loxep/domain`'s
 * `UserPreferencesService`, `@/server/preferences-functions`) — TanStack
 * Query is the cache, matching the frontend standards' state-ownership rule
 * ("server data lives in TanStack Query — never duplicated into Zustand").
 * There is no store left in this module; every export below is either a pure
 * helper or a hook over `pinnedPagesQuery`.
 */
export type PinnedPage = {
  title: string;
  url: string;
  icon: NavItem['icon'];
  workspaceId: WorkspaceId;
};

/**
 * loxep-koj's original localStorage key. Read exactly once per page session
 * (see the module-level merge guard below) to migrate any pre-existing pins
 * into the server copy, then removed — this constant only still exists for
 * that one-time migration and its tests.
 */
export const PINNED_PAGES_STORAGE_KEY = 'loxep.dashboard.pinnedPages';

function isPinnedPage(value: unknown): value is PinnedPage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.title === 'string' &&
    typeof candidate.url === 'string' &&
    typeof candidate.workspaceId === 'string'
  );
}

/**
 * Pure parse: malformed or foreign localStorage content degrades to an
 * empty list rather than throwing (private browsing, a stale shape from a
 * future version, manual tampering).
 */
export function parsePinnedPages(raw: string | null): PinnedPage[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPinnedPage);
  } catch {
    return [];
  }
}

/** Pure toggle: pins `page` if absent, unpins it (matched by url) if present. */
export function togglePinnedPage(pinned: PinnedPage[], page: PinnedPage): PinnedPage[] {
  return pinned.some((entry) => entry.url === page.url)
    ? pinned.filter((entry) => entry.url !== page.url)
    : [...pinned, page];
}

/** Pure unpin by url. */
export function removePinnedPage(pinned: PinnedPage[], url: string): PinnedPage[] {
  return pinned.filter((entry) => entry.url !== url);
}

/**
 * Pure union of the server's pins with the browser's leftover localStorage
 * pins, deduped by url — the server copy always wins a conflict (it is the
 * durable source once this merge has run at all). Used exactly once, by the
 * one-time migration below.
 */
export function mergePinnedPages(server: PinnedPage[], local: PinnedPage[]): PinnedPage[] {
  const existingUrls = new Set(server.map((entry) => entry.url));
  const additions = local.filter((entry) => !existingUrls.has(entry.url));
  return additions.length === 0 ? server : [...server, ...additions];
}

function readLocalStoragePins(): PinnedPage[] {
  if (typeof window === 'undefined') return [];
  try {
    return parsePinnedPages(window.localStorage.getItem(PINNED_PAGES_STORAGE_KEY));
  } catch {
    // Private browsing / storage disabled: nothing to migrate this session.
    return [];
  }
}

function clearLocalStoragePins(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(PINNED_PAGES_STORAGE_KEY);
  } catch {
    // Ignore — see readLocalStoragePins.
  }
}

/**
 * `@loxep/domain`'s `pinnedPageSchema` deliberately keeps `icon`/`workspaceId`
 * as plain strings (see that schema's own doc comment) — closing them to
 * `NavItem['icon']`/`WorkspaceId` would require the domain package to depend
 * on `apps/web`'s icon registry and workspace config. This is the one place
 * that narrows a server DTO back to the client's typed shape: an icon key
 * that no longer resolves in `Icons` degrades to `undefined` (every consumer
 * already falls back to a default icon for a falsy `icon`), and a
 * `workspaceId` is passed through as-is — `workspaceLabel()` already falls
 * back to the raw id for one that no longer matches a configured workspace.
 */
function toPinnedPage(entry: PinnedPagePreferenceEntry): PinnedPage {
  return {
    title: entry.title,
    url: entry.url,
    icon: entry.icon in Icons ? (entry.icon as NavItem['icon']) : undefined,
    workspaceId: entry.workspaceId as WorkspaceId
  };
}

function toPinnedPages(entries: PinnedPagePreferenceEntry[]): PinnedPage[] {
  return entries.map(toPinnedPage);
}

/**
 * What the server accepts back — `icon`/`workspaceId` widened to plain
 * strings, matching `pinnedPageSchema`. `pinnedPageSchema.icon` requires a
 * non-empty string, so a nav item with no icon of its own (`NavItem.icon` is
 * optional) falls back to `'page'` — the same default every render site
 * already uses for a falsy `icon` (`page.icon ? Icons[page.icon] : Icons.page`
 * in `PinnedNavGroup`) — rather than sending `''` and failing validation.
 */
function toPreferenceEntry(page: PinnedPage): PinnedPagePreferenceEntry {
  return {
    title: page.title,
    url: page.url,
    icon: page.icon ?? 'page',
    workspaceId: page.workspaceId
  };
}

function toPreferenceEntries(pages: PinnedPage[]): PinnedPagePreferenceEntry[] {
  return pages.map(toPreferenceEntry);
}

export const pinnedPagesQuery = queryOptions({
  queryKey: ['preferences', 'pinned-pages'],
  queryFn: () => fetchPinnedPages().then(toPinnedPages)
});

/**
 * Module-scoped, not per-component: every mounted consumer of
 * `usePinnedPages`/`useIsPinned` runs the same effect, and this flag is what
 * keeps the migration a genuine ONE-TIME event per page load rather than one
 * attempt per mounted component (the sidebar renders `NavPinToggle` on every
 * nav leaf across every workspace). Resets on a full page reload, which is
 * harmless: by then localStorage has already been cleared by a prior success,
 * so the next attempt reads an empty list and no-ops.
 */
let localMergeState: 'idle' | 'pending' | 'done' = 'idle';

/** Test-only: resets the module-level merge guard between test cases. */
export function resetPinnedPagesMergeStateForTests(): void {
  localMergeState = 'idle';
}

function saveMergedPins(
  queryClient: QueryClient,
  merged: PinnedPage[],
  mutate: (
    pages: PinnedPage[],
    options: { onSuccess: (saved: PinnedPage[]) => void; onError: () => void }
  ) => void
): void {
  mutate(merged, {
    onSuccess: (saved) => {
      queryClient.setQueryData(pinnedPagesQuery.queryKey, saved);
      clearLocalStoragePins();
      localMergeState = 'done';
    },
    onError: () => {
      // Leave localStorage intact — the next mount that observes 'idle' (a
      // fresh page load) retries.
      localMergeState = 'idle';
    }
  });
}

/**
 * The one hook every export below is built on: subscribes to the server
 * query and, on its first successful resolution this page session, performs
 * the ONE-TIME migration of any pre-existing localStorage pins.
 */
function usePinnedPagesQuery() {
  const queryClient = useQueryClient();
  const query = useQuery(pinnedPagesQuery);
  const mergeMutation = useMutation({
    mutationFn: (pages: PinnedPage[]) =>
      savePinnedPages({ data: toPreferenceEntries(pages) }).then(toPinnedPages)
  });
  const migrateLocalPins = React.useEffectEvent((merged: PinnedPage[]) => {
    saveMergedPins(queryClient, merged, mergeMutation.mutate);
  });

  React.useEffect(() => {
    if (query.data === undefined || localMergeState !== 'idle') return;
    const local = readLocalStoragePins();
    if (local.length === 0) {
      localMergeState = 'done';
      return;
    }
    localMergeState = 'pending';
    const merged = mergePinnedPages(query.data, local);
    migrateLocalPins(merged);
  }, [query.data]);

  return query;
}

/** Hydrates from the server and returns the live pinned list; `[]` until the first fetch resolves. */
export function usePinnedPages(): PinnedPage[] {
  const { data } = usePinnedPagesQuery();
  return data ?? [];
}

/** Whether `url` is currently pinned. Shares the same query as `usePinnedPages`. */
export function useIsPinned(url: string): boolean {
  const { data } = usePinnedPagesQuery();
  return (data ?? []).some((entry) => entry.url === url);
}

/**
 * Optimistic toggle/unpin mutations over the server-backed pin list —
 * `NavPinToggle` and `PinnedNavGroup`'s replacement for the old
 * `usePinnedPagesStore((state) => state.togglePin | state.unpin)` zustand
 * access. The mutation applies the pure helpers above to whatever the query
 * cache currently holds, writes the result optimistically, and rolls back on
 * a failed save.
 */
export function usePinnedPagesActions(): {
  togglePin: (page: PinnedPage) => void;
  unpin: (url: string) => void;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: (pages: PinnedPage[]) =>
      savePinnedPages({ data: toPreferenceEntries(pages) }).then(toPinnedPages),
    onMutate: async (pages) => {
      await queryClient.cancelQueries({ queryKey: pinnedPagesQuery.queryKey });
      const previous = queryClient.getQueryData<PinnedPage[]>(pinnedPagesQuery.queryKey);
      queryClient.setQueryData(pinnedPagesQuery.queryKey, pages);
      return { previous };
    },
    onError: (_error, _pages, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(pinnedPagesQuery.queryKey, context.previous);
      }
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(pinnedPagesQuery.queryKey, saved);
    }
  });

  const togglePin = React.useCallback(
    (page: PinnedPage) => {
      const current = queryClient.getQueryData<PinnedPage[]>(pinnedPagesQuery.queryKey) ?? [];
      mutation.mutate(togglePinnedPage(current, page));
    },
    [queryClient, mutation]
  );

  const unpin = React.useCallback(
    (url: string) => {
      const current = queryClient.getQueryData<PinnedPage[]>(pinnedPagesQuery.queryKey) ?? [];
      mutation.mutate(removePinnedPage(current, url));
    },
    [queryClient, mutation]
  );

  return { togglePin, unpin };
}
