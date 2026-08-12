---
name: add-settings-surface
description: Add a page under /settings in apps/web — an administration, diagnostics, directory, storage, notifications, or application-configuration surface — with its nav group placement, admin service registry wiring (including @vite-ignore dynamic imports for packages that pull graphile-worker), metadata-only server-function DTOs, and write-only secret fields. Use when asked to expose a new setting, credential, backend, endpoint, or admin table. For a page outside /settings use add-workspace-surface.
---

The `/settings` workspace is administration and diagnostics for the whole installation. It is
the only place provider secrets are entered, and every one of its server functions returns
**metadata only**. Constraints: ADR-0016 (configuration), ADR-0017 (roles/entities), ADR-0019
(secret schema), and `apps/docs/src/content/docs/architecture/configuration-and-secrets.md`.

Start from the generic path in the `add-workspace-surface` skill; this skill is the settings
delta.

## 1. Nav placement

`apps/web/src/config/navigation/settings.ts` already has the groups
`General · Directory · Storage · Notifications · Users · Application`. Put the page in the
existing group it belongs to; only add a group for a genuinely new concern, and keep the
`shortcut` letters unique across the file.

## 2. Route and page frame

`apps/web/src/routes/settings/<page>.tsx`, using the shared frame (never a hand-rolled header):

```tsx
const { auth } = Route.useRouteContext();
const isAdmin = auth?.roles.includes('admin') ?? false;
return <SettingsPage title='Storage backends' description='…'>{…}</SettingsPage>;
```

`SettingsPage` and `StatusBadge` live in
`apps/web/src/features/settings/components/settings-page.tsx`. Members can view settings
surfaces; admin-only affordances are hidden/disabled from `isAdmin`, and the server re-checks.

## 3. Services come from the admin registry

`apps/web/src/server/admin.ts` is the lazy process-global registry (keyed by
`Symbol.for('loxep.web.admin')` because vite dev and the Nitro bundle each carry a copy of the
module). `entities`, `connections`, `settings`, `secrets` are built eagerly in `buildRegistry()`.

**Any package whose index re-exports job/task code must be reached through a
runtime-resolved dynamic import**, or the SSR bundle breaks at runtime (`__filename` in ESM)
because `graphile-worker` and its cosmiconfig/TypeScript CJS chain get bundled.
(`@loxep/storage` no longer needs this — its jobs-dependent migration service moved behind
the `@loxep/storage/migration` subpath, so the default entry imports statically; the pattern
below still applies to `@loxep/notifications` and `@loxep/market`, whose indexes re-export
job code):

```ts
export function getNotificationsModule(): Promise<typeof import('@loxep/notifications')> {
  const registry = getAdminServices();
  registry.notificationsModulePromise ??= (async () => {
    const specifier = '@loxep/notifications';      // variable specifier — not a literal
    return (await import(/* @vite-ignore */ specifier)) as typeof import('@loxep/notifications');
  })();
  return registry.notificationsModulePromise;
}
```

Today that covers `@loxep/storage`, `@loxep/notifications`, and `@loxep/market`. Add a new
`…ModulePromise` / `…ServicePromise` field to `AdminRegistry` and a matching getter; never a
static top-level import of one of those packages anywhere under `apps/web/src`.

## 4. Server functions: metadata only, secrets write-only

Add to `apps/web/src/server/admin-functions.ts` under a `// ---- Section ----` banner,
following the file's existing shape: `createServerFn` + zod `strictObject` `inputValidator` +
handler that dynamically imports `@/server/admin`, calls `requireSession` (reads) or
`requireAdmin` (mutations), and maps rows to a DTO with `iso()` timestamps.

- **Never return credential material.** Return presence/shape instead — the pattern is `ConnectionCredentialDto`: `{ credentialType, currentVersion, expiresAt, refreshAfter, updatedAt }`. Status resolvers read only that metadata.
- **Secret fields are write-only.** Submitted once, encrypted server-side, never read back and never re-rendered into a form. An edit form shows "replace" affordances, not the current value.
- Facts that are deployment properties rather than secrets (the eBay callback URL) may be returned and shown with a copy button — see `ebayCallbackUrlQuery` in `apps/web/src/features/settings/api/queries.ts`.
- Never log plaintext credentials, and never put them in job payloads, audit snapshots, or error details.
- Configuration that is not a bootstrap/pre-DB fact lives in PostgreSQL via the settings service — **not** in a new `LOXEP_*` env var or Compose variable.

## 5. Client wiring

- `queryOptions` in `apps/web/src/features/settings/api/queries.ts`, keyed `['settings', …]`; mutations `invalidateQueries({ queryKey: <query>.queryKey })` and toast on both success and error.
- Dialog forms use `useAppForm` with `validators: { onSubmit: schema }` — pattern:
  `apps/web/src/features/settings/components/entity-form-dialog.tsx`.
- Any credential form carries inline acquisition guidance built from
  `apps/web/src/features/settings/components/setup-guidance.tsx`
  (`SetupGuidance` / `GuidanceSteps` / `GuidanceStep` / `GuidanceNote` / `GuidanceCallout` /
  `GuidanceLink` / `CopyableValue`). A form that only labels its fields sends the operator out
  of the app to find out what to type.
- Tables follow the `add-data-table` skill.

## Never on a settings surface

- A raw JSON config textarea, or an operator typing a `provider`/`kind` string — those are system-supplied from `apps/web/src/features/settings/integrations-catalog.ts`.
- Per-connection, per-workspace, or per-entity ACLs; `connection_users`; a generic permission engine. Phase 0 roles are `admin`/`member` only.
- Treating an economic entity as a user, a permission container, or an accounting book. Its field description is literally "Business context only — grants and restricts nothing."

## Done when

- [ ] Nav item in the correct group with a unique shortcut; page uses `SettingsPage`.
- [ ] New job-carrying package reached only through a `@vite-ignore` variable-specifier import cached on the registry.
- [ ] Reads `requireSession`, mutations `requireAdmin`; DTOs carry no secret material.
- [ ] Secret inputs are write-only; credential forms carry setup guidance.
- [ ] `bun run typecheck` and `bun run lint` clean; surface checked in two themes plus dark mode.
