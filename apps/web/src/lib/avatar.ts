/**
 * Shared conventions for a Loxep-hosted avatar image (loxep-0oq).
 *
 * `/api/account/avatar` (POST) stores an uploaded image through
 * `@loxep/storage`'s media service and writes this relative URL — never an
 * absolute one — into Better Auth's `user.image` column, so it works
 * unchanged behind any host/proxy. `/api/media/avatar/$mediaId` (GET) serves
 * it back. Both the client form and the server upload/serve handlers import
 * this module so the URL shape and the "is this a Loxep-stored avatar, or an
 * external OIDC/user-supplied URL" test live in exactly one place.
 */
const AVATAR_PATH_PREFIX = '/api/media/avatar/';
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const AVATAR_URL_PATTERN = new RegExp(`^${AVATAR_PATH_PREFIX}(${UUID_SOURCE})$`, 'i');

/** The serving URL Better Auth's `user.image` is set to on upload. */
export function avatarServingUrl(mediaObjectId: string): string {
  return `${AVATAR_PATH_PREFIX}${mediaObjectId}`;
}

/**
 * The media object id when `value` is a Loxep-hosted avatar URL produced by
 * {@link avatarServingUrl}; `null` for anything else (external URLs, empty
 * values). Used to decide replace semantics: only a Loxep-stored avatar is
 * ever deleted when a new one is uploaded.
 */
export function extractAvatarMediaId(value: string): string | null {
  const match = AVATAR_URL_PATTERN.exec(value.trim());
  return match ? (match[1] as string).toLowerCase() : null;
}

/** Accepted avatar field values: an absolute http(s) URL, or our own avatar serving path. */
export function isValidAvatarUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value) || extractAvatarMediaId(value) !== null;
}
