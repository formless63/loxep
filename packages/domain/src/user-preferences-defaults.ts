/**
 * The registered user preferences Loxep ships with (loxep-lbj), mirroring
 * `settings-defaults.ts`'s "definitions live beside the registry, imported
 * by every process through `@loxep/domain`'s entrypoint" discipline — see
 * that module's doc comment for the full reasoning, which applies here
 * unchanged.
 *
 * One entry today: `dashboard.pinned_pages`, replacing loxep-koj's
 * localStorage-only pin list with durable per-user storage.
 */
import { z } from "zod";
import { defineUserPreference } from "./user-preferences.ts";

/**
 * One pinned page on the `/dashboard` launchpad. Mirrors `apps/web`'s
 * `PinnedPage` type (`src/hooks/use-pinned-pages.ts`) field-for-field —
 * `icon`/`workspaceId` are typed unions on the client (`NavItem['icon']`,
 * `WorkspaceId`), but this schema deliberately does not enumerate either:
 * closing them here would require `@loxep/domain` to depend on
 * `apps/web`'s icon registry and workspace config, inverting the
 * dependency direction the same way `documentsParserIdSetting` explains for
 * `@loxep/documents`' parser ids. An icon/workspace id that no longer
 * resolves client-side degrades to that surface's own fallback rendering
 * rather than failing validation here.
 */
export const pinnedPageSchema = z.strictObject({
  title: z.string().min(1).max(200).describe("Display title shown in the Pinned nav group"),
  url: z.string().min(1).max(2048).describe("Route path the pin navigates to"),
  icon: z.string().min(1).max(100).describe("Icons registry key rendered beside the title"),
  workspaceId: z
    .string()
    .min(1)
    .max(100)
    .describe("Workspace id shown as the pin's badge"),
});

export type PinnedPagePreferenceEntry = z.infer<typeof pinnedPageSchema>;

/** Upper bound on how many pages one user may pin — generous headroom over any real launchpad, never a soft nudge to unpin. */
export const MAX_PINNED_PAGES = 50;

export const dashboardPinnedPagesPreference = defineUserPreference({
  key: "dashboard.pinned_pages",
  schema: z.array(pinnedPageSchema).max(MAX_PINNED_PAGES),
  defaultValue: [],
});

/** Every definition this module registers, for diagnostics and tests. */
export const registeredUserPreferences = [dashboardPinnedPagesPreference] as const;
