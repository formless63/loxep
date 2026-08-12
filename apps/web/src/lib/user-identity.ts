/**
 * How Loxep names a person in the interface.
 *
 * Better Auth's `user` model carries the full name (`name`) and the avatar
 * (`image`); Loxep adds `displayName` (`@loxep/db` `userAdditionalFields`) for
 * the short label a user picks for themselves. Every identity surface — the
 * sidebar account button, the profile page, anything added later — resolves
 * the same way so they cannot drift apart:
 *
 *     displayName  →  name  →  email  →  'User'
 */

export interface UserIdentity {
  name?: string | null;
  displayName?: string | null;
  email?: string | null;
}

function firstNonBlank(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** The label to show wherever the signed-in person is named. */
export function userDisplayLabel(user: UserIdentity | null | undefined): string {
  return firstNonBlank(user?.displayName, user?.name, user?.email) ?? 'User';
}

/** Up to two letters for an avatar fallback, derived from the display label. */
export function userInitials(user: UserIdentity | null | undefined): string {
  const label = userDisplayLabel(user);
  const words = label.split(/[\s@._-]+/).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : label.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * Split a stored full name back into the first/last inputs the profile form
 * shows. Better Auth owns exactly one `name` column, so the split is a
 * presentation convenience, not a second model: the first whitespace-delimited
 * token is the first name and everything after it is the last name, which
 * keeps multi-word surnames ("van der Berg") intact.
 */
export function splitFullName(name: string | null | undefined): {
  firstName: string;
  lastName: string;
} {
  const trimmed = (name ?? '').trim();
  if (trimmed.length === 0) return { firstName: '', lastName: '' };
  const separator = trimmed.search(/\s/);
  if (separator === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, separator),
    lastName: trimmed.slice(separator + 1).trim()
  };
}
