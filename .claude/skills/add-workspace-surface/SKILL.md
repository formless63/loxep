---
name: add-workspace-surface
description: Add a page to an existing Loxep workspace (/dashboard, /market, /settings) or stand up a brand-new peer workspace in apps/web — workspaces.ts entry, config/navigation/<id>.ts nav group, guarded layout route, feature module, and server functions split across requireSession/requireAdmin. Use for "add a section/page/tab/workspace", new product areas, or new sidebar entries. For a page under /settings use add-settings-surface instead.
---

Navigation is configuration-driven: one workspace entry feeds the sidebar, the workspace
switcher, and the Cmd+K palette. Adding a page means editing config, not wiring three
components. Constraints: `apps/docs/src/content/docs/development/implementation-contract.md`
and `apps/docs/src/content/docs/product/workspaces.md`.

**A workspace is a navigation surface, never an ownership boundary.** Do not create a DB
schema, a package, a tenant, or an ACL to mirror one. Future major product areas are peers of
`/dashboard` (`/market` is the precedent) — never children of it. Never delete or re-copy the
`/starter/*` donor workspace.

## Adding a page to an existing workspace

1. **Nav entry** — `apps/web/src/config/navigation/<workspace>.ts`. Add an item to the right
   `NavGroup`, or a new group when the page is a new concern:

   ```ts
   { title: 'Opportunities', url: '/market/opportunities', icon: 'product',
     isActive: false, shortcut: ['g', 'o'], items: [] }
   ```

   `icon` is a key of `@/components/icons`. Cmd+K, the sidebar, and the shortcut come free —
   both consumers read `getWorkspaceForPath(pathname).navGroups`
   (`apps/web/src/components/layout/app-sidebar.tsx`, `apps/web/src/components/command-menu.tsx`).

2. **Route** — `apps/web/src/routes/<workspace>/<page>.tsx`. The layout route above it already
   guards the session, so the page route only composes:

   ```tsx
   export const Route = createFileRoute('/market/opportunities')({ component: MarketOpportunities });

   function MarketOpportunities() {
     const { auth } = Route.useRouteContext();
     const isAdmin = auth?.roles.includes('admin') ?? false;
     return <SettingsPage title='…' description='…'><OpportunitiesTable isAdmin={isAdmin} /></SettingsPage>;
   }
   ```

   `routeTree.gen.ts` is generated — never hand-edit it.

3. **Feature module** — `apps/web/src/features/<feature>/`: `components/`, `api/queries.ts`,
   `constants.ts`. Tables follow the `add-data-table` skill; forms use `useAppForm`.

## Standing up a new peer workspace

4. **Nav config** — new `apps/web/src/config/navigation/<id>.ts` exporting `<id>NavGroups: NavGroup[]`.

5. **Workspace entry** — `apps/web/src/config/workspaces.ts`: widen `WorkspaceId` and push an entry.

   ```ts
   { id: 'inventory', label: 'Inventory', description: 'Stock, acquisitions, and movements',
     root: '/inventory', defaultPath: '/inventory/overview', navGroups: inventoryNavGroups }
   ```

6. **Guarded layout route** — `apps/web/src/routes/<id>.tsx`, copied from
   `apps/web/src/routes/settings.tsx`: `beforeLoad` redirects to `/auth/sign-in` when
   `!context.auth`, `head()` sets a title/description plus `robots: noindex, nofollow`, and the
   component wraps `CommandMenu > SidebarProvider > skip-link + AppSidebar + SidebarInset(Header,
   InfobarProvider, Outlet, InfoSidebar)`. Do not invent a different shell.

7. **Index redirect** — `routes/<id>/index.tsx` redirecting to `defaultPath`, matching
   `routes/settings/index.tsx`.

## Server functions for the surface

New surfaces get their data from server functions in `apps/web/src/server/`, modelled on
`admin-functions.ts` / `market-functions.ts`:

```ts
export const fetchMonitors = createServerFn({ method: 'GET' }).handler(async (): Promise<MonitorDto[]> => {
  const { requireSession, getMonitorService } = await import('@/server/admin');
  await requireSession();
  …
});

export const createMonitor = createServerFn({ method: 'POST' })
  .inputValidator(createMonitorInput)          // zod at the boundary
  .handler(async ({ data }) => {
    const { requireAdmin, getMonitorService } = await import('@/server/admin');
    const session = await requireAdmin();      // actorUserId = session.user.id
    …
  });
```

Non-negotiable (ADR-0017, ADR-0018):

- **Role split**: reads of ordinary product data → `requireSession`; mutations and user listing → `requireAdmin`. Both live in `apps/web/src/server/admin.ts`, which sets 401/403 response status for you.
- **Dynamic import inside the handler.** Only *type-only* imports of server packages at module top level, so `@/server/admin` and the domain packages stay out of the client bundle.
- Return **DTOs with ISO strings** (`iso(row.createdAt)`), never `Date` objects, `Buffer`s, or credential material.
- Zod `strictObject` input validators; server functions are internal, and the durable external surface is a future `/api/v1` — do not add tRPC.

## Copy policy

Titles and one-line descriptions on a surface are **generic product prose**. No bead/issue ids
(`loxep-…`), no phase numbers, no roadmap references, no "coming soon" in shipped copy — those
belong in code comments and the tracker. Describe what the page *is*:

> Economic entities — "Attribution and business-context records — not users, permissions, or accounting books."

Keep the same voice for empty states and field descriptions.

## Done when

- [ ] Nav config edited (not the sidebar or command menu components).
- [ ] Layout route guards `context.auth`; page route composes only.
- [ ] No new DB table, package, or ACL created to mirror the workspace.
- [ ] Reads gated by `requireSession`, mutations by `requireAdmin`, handlers dynamically importing server modules.
- [ ] Surface obeys `apps/docs/src/content/docs/development/frontend-standards.md` — verified in two themes plus dark mode.
