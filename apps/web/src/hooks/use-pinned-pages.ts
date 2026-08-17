import * as React from 'react';
import { create } from 'zustand';
import type { NavItem } from '@/types';
import type { WorkspaceId } from '@/config/workspaces';

/**
 * A user-pinned page for the /dashboard launchpad (loxep-koj).
 *
 * PROVISIONAL per the bead: localStorage-only for v1, no migration, no
 * server function — revisit only if a per-user server-side prefs mechanism
 * lands later. This is cross-component ephemeral UI state, the one case the
 * frontend standards sanction zustand for (never duplicated server data).
 */
export type PinnedPage = {
  title: string;
  url: string;
  icon: NavItem['icon'];
  workspaceId: WorkspaceId;
};

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

function readStorage(): PinnedPage[] {
  if (typeof window === 'undefined') return [];
  try {
    return parsePinnedPages(window.localStorage.getItem(PINNED_PAGES_STORAGE_KEY));
  } catch {
    // Private browsing / storage disabled: pins simply don't persist this session.
    return [];
  }
}

function writeStorage(pinned: PinnedPage[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PINNED_PAGES_STORAGE_KEY, JSON.stringify(pinned));
  } catch {
    // Ignore — see readStorage.
  }
}

type PinnedPagesStore = {
  pinned: PinnedPage[];
  hydrated: boolean;
  /** Loads from localStorage once. Safe to call repeatedly; a no-op after the first. */
  hydrate: () => void;
  togglePin: (page: PinnedPage) => void;
  unpin: (url: string) => void;
};

export const usePinnedPagesStore = create<PinnedPagesStore>()((set, get) => ({
  pinned: [],
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return;
    set({ pinned: readStorage(), hydrated: true });
  },
  // Both mutators fall back to reading storage directly when called before
  // hydration (e.g. a pin toggle firing before the launchpad's own mount
  // effect runs) — otherwise they would silently overwrite an
  // already-persisted list with a single-item one.
  togglePin: (page) =>
    set((state) => {
      const base = state.hydrated ? state.pinned : readStorage();
      const pinned = togglePinnedPage(base, page);
      writeStorage(pinned);
      return { pinned, hydrated: true };
    }),
  unpin: (url) =>
    set((state) => {
      const base = state.hydrated ? state.pinned : readStorage();
      const pinned = removePinnedPage(base, url);
      writeStorage(pinned);
      return { pinned, hydrated: true };
    })
}));

/**
 * Hydrates from localStorage on first client mount and returns the live
 * pinned list. SSR renders an empty list — the same "empty until mounted"
 * pattern the notification bell's `lastSeenAt` uses — so there is no
 * hydration mismatch, just a one-frame update after mount.
 */
export function usePinnedPages(): PinnedPage[] {
  const hydrate = usePinnedPagesStore((state) => state.hydrate);
  React.useEffect(() => {
    hydrate();
  }, [hydrate]);
  return usePinnedPagesStore((state) => state.pinned);
}

/** Whether `url` is currently pinned. Triggers hydration on mount, same as `usePinnedPages`. */
export function useIsPinned(url: string): boolean {
  const hydrate = usePinnedPagesStore((state) => state.hydrate);
  React.useEffect(() => {
    hydrate();
  }, [hydrate]);
  return usePinnedPagesStore((state) => state.pinned.some((entry) => entry.url === url));
}
