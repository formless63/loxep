/**
 * The one mapper from a media object's OWN `metadata.purpose` to its serving
 * route (loxep-cd3.2, M2 — `expense-entry-design.md`, "The serving-URL rule,
 * which is a real trap").
 *
 * The four `/api/media/<kind>/:id` routes are single-purpose by deliberate
 * design, each gated on `media_objects.metadata.purpose` — see
 * `@/server/receipt-media.ts`, `@/server/documents-media.ts`,
 * `@/server/inventory-media.ts`, `@/server/avatar.ts`. Before this module
 * existed, `@/server/expense-functions.ts`'s `fetchExpense` built
 * `'/api/media/receipt/' + id` UNCONDITIONALLY for every attached receipt —
 * which is wrong the moment a receipt's underlying object was uploaded
 * through `/api/documents/upload` (stamped `metadata.purpose = 'document'`)
 * and then attached to an expense via `ReceiptsService.attach`. That object
 * 404s behind `/api/media/receipt/:id`, because the route's own gate checks
 * the OBJECT's purpose, not the resource it happens to be linked to today.
 *
 * `media_links.purpose` (`receipt | invoice | supporting_document`, how an
 * attachment relates to a RESOURCE) is a completely different column from
 * `media_objects.metadata.purpose` (how the OBJECT itself was created) —
 * same English word, two independent facts. This mapper only ever reads the
 * latter, and MUST be the only place that turns a purpose into a URL: every
 * DTO that returns a `servingUrl` for an arbitrary media object (as opposed
 * to one it just uploaded itself and already knows the route for) calls this
 * function rather than re-deriving the string.
 *
 * Rule this exists to enforce: no purpose gate is ever widened to make one
 * endpoint serve another purpose (Phase 9's rule 9). A media object whose
 * purpose does not map to a known route returns `null` — the DTO surfaces
 * "no preview" rather than guessing a URL that would 404.
 */

const SERVING_ROUTE_BY_MEDIA_PURPOSE: Record<string, string> = {
  receipt: '/api/media/receipt',
  document: '/api/media/document',
  item_image: '/api/media/inventory',
  avatar: '/api/media/avatar'
};

/** Extracts `metadata.purpose` from a media object's loosely-typed `metadata` column (mirrors the extraction each serving route's own gate already does). */
export function mediaObjectPurpose(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return null;
  }
  const purpose = (metadata as Record<string, unknown>).purpose;
  return typeof purpose === 'string' ? purpose : null;
}

/**
 * The one servingUrl derivation. `purpose` is the media OBJECT's own
 * `metadata.purpose` (pass the result of {@link mediaObjectPurpose}, or a
 * value already known to be one of the four), never `media_links.purpose`.
 * Returns `null` for a purpose with no serving route — a DTO should render
 * "no preview available" rather than a URL that 404s.
 */
export function servingUrlFor(purpose: string | null, mediaObjectId: string): string | null {
  if (purpose === null) return null;
  const route = SERVING_ROUTE_BY_MEDIA_PURPOSE[purpose];
  return route ? `${route}/${mediaObjectId}` : null;
}
