import { useSyncExternalStore } from 'react';

const MEDIA_QUERY = '(max-width: 768px)';

function subscribe(onStoreChange: () => void) {
  const query = window.matchMedia(MEDIA_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getSnapshot() {
  return window.matchMedia(MEDIA_QUERY).matches;
}

function getServerSnapshot() {
  return false;
}

export function useMediaQuery() {
  const isOpen = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { isOpen };
}
