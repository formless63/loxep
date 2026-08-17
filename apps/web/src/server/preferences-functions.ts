/**
 * Server functions for `dashboard.pinned_pages` (loxep-lbj) — durable
 * per-user pin persistence, replacing loxep-koj's localStorage-only store.
 *
 * Both handlers gate with `requireSession` (any authenticated user, never
 * `requireAdmin`) and operate ONLY on `session.user.id` — the client never
 * supplies a user id, mirroring `updateProfile`'s self-service shape in
 * `@/server/auth-functions.ts`. `@loxep/domain`'s `UserPreferencesService`
 * does its own `safeParse` against the registered
 * `dashboardPinnedPagesPreference` schema before persisting; this module
 * adds no separate validation.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { PinnedPagePreferenceEntry } from '@loxep/domain';

export const fetchPinnedPages = createServerFn({ method: 'GET' }).handler(
  async (): Promise<PinnedPagePreferenceEntry[]> => {
    const { requireSession, getUserPreferencesService } = await import('@/server/admin');
    const { dashboardPinnedPagesPreference } = await import('@loxep/domain');
    const session = await requireSession();
    return getUserPreferencesService().get(session.user.id, dashboardPinnedPagesPreference);
  }
);

// Mirrors `@loxep/domain`'s `pinnedPageSchema`/`dashboardPinnedPagesPreference.schema`
// literally (shape, `.max(50)` cap) rather than importing it: `createServerFn`'s
// `.inputValidator` needs a schema at module-evaluation time, before the
// request-scoped dynamic `@loxep/domain` import above runs, and `@loxep/domain`
// pulls `@loxep/db` (a `pg` dependency) that must stay out of the client
// bundle — the same "duplicated as literals" trade `ebayRateBudgetSetting`
// documents in `packages/domain/src/settings-defaults.ts`. The service's own
// `safeParse` against the registered schema remains the sole validation
// authority (loxep-lbj) — this copy only lets a malformed request fail fast,
// with the same shape, before a dynamic import even runs.
const pinnedPageInput = z.strictObject({
  title: z.string().min(1).max(200),
  url: z.string().min(1).max(2048),
  icon: z.string().min(1).max(100),
  workspaceId: z.string().min(1).max(100)
});

const savePinnedPagesInput = z.array(pinnedPageInput).max(50);

export const savePinnedPages = createServerFn({ method: 'POST' })
  .inputValidator(savePinnedPagesInput)
  .handler(async ({ data }): Promise<PinnedPagePreferenceEntry[]> => {
    const { requireSession, getUserPreferencesService } = await import('@/server/admin');
    const { dashboardPinnedPagesPreference } = await import('@loxep/domain');
    const session = await requireSession();
    return getUserPreferencesService().set(session.user.id, dashboardPinnedPagesPreference, data);
  });
