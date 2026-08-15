/**
 * Server functions bridging the client/router to the server-side auth
 * instance. Handlers use dynamic imports so `@/server/auth` (and the server
 * packages behind it) stay out of the client bundle; only type-only imports
 * from server packages are allowed at the top level here.
 */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { LoxepRole } from '@loxep/auth';
import { isValidAvatarUrl } from '@/lib/avatar';

export interface SessionInfo {
  user: {
    id: string;
    /** Full name — Better Auth's own `name` column, composed from first + last. */
    name: string;
    /**
     * Short, self-chosen label ("Will" for "Alex Rivera"). Null when the
     * user has neither set one nor arrived with an OIDC `nickname`/
     * `preferred_username` claim; every identity display falls back to
     * `name`, then `email`.
     */
    displayName: string | null;
    email: string;
    image: string | null;
  };
  roles: LoxepRole[];
}

export interface LoginPaths {
  magicLink: boolean;
  oidc: boolean;
  /**
   * Whether each method may create a NEW account right now (ADR-0024) — the
   * stored provisioning policy, unless the installation still has no
   * administrator, in which case both read `true` because provisioning is
   * force-open until it does.
   *
   * Deliberately disclosed to an anonymous visitor: it is the message a
   * newcomer needs ("an administrator has to create your account"), and it
   * says nothing about any individual account.
   */
  newAccounts: { magicLink: boolean; oidc: boolean };
}

/**
 * Current session as `{ user, roles }`, or `null` when unauthenticated.
 * Reads the incoming request's headers (cookies) per the Better Auth
 * TanStack Start integration: `auth.api.getSession({ headers })`.
 */
export const fetchSessionInfo = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SessionInfo | null> => {
    const [{ getAuth }, { sessionRoles }, { getRequestHeaders }] = await Promise.all([
      import('@/server/auth'),
      import('@loxep/auth'),
      import('@tanstack/react-start/server')
    ]);
    const session = await getAuth().api.getSession({ headers: getRequestHeaders() });
    if (!session) return null;
    return {
      user: {
        id: session.user.id,
        name: session.user.name,
        displayName: readDisplayName(session.user),
        email: session.user.email,
        image: session.user.image ?? null
      },
      roles: sessionRoles(session)
    };
  }
);

/**
 * `displayName` is a Better Auth *additional field* (`@loxep/db`
 * `userAdditionalFields`), so it rides along on the session user at runtime
 * but is not part of the base `User` type Better Auth exports. Reading it
 * through one narrow accessor keeps the cast in a single place.
 */
function readDisplayName(user: object): string | null {
  const value = (user as { displayName?: unknown }).displayName;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** One trimmed line, or null when the field is blank. */
const optionalLine = (max: number, label: string) =>
  z
    .string()
    .max(max, `${label} must be ${max} characters or fewer`)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value));

/**
 * Self-service profile input. Names are entered as first/last and composed
 * into Better Auth's single `name` column — the auth model stays exactly what
 * the schema generator produces (ADR-0020), and the split lives in the form.
 */
const updateProfileInput = z.strictObject({
  firstName: z
    .string()
    .trim()
    .min(1, 'First name is required')
    .max(100, 'First name must be 100 characters or fewer'),
  lastName: optionalLine(100, 'Last name'),
  displayName: optionalLine(80, 'Display name'),
  /**
   * Avatar URL. Either an absolute http(s) URL the user (or their OIDC
   * issuer) supplies, or a Loxep-hosted avatar serving path written by
   * `/api/account/avatar` (`avatarServingUrl`) — the file-picker upload path
   * writes this field the same way the URL field always has, through this
   * same server function's `updateUser` call.
   */
  imageUrl: optionalLine(2048, 'Avatar URL').refine(
    (value) => value === null || isValidAvatarUrl(value),
    'Avatar URL must be an http(s) URL'
  )
});

export type UpdateProfileInput = z.input<typeof updateProfileInput>;

/**
 * Update the signed-in user's own profile. Self-service: gated by
 * `requireSession`, never `requireAdmin`, and it can only ever touch the
 * caller's row — Better Auth's `updateUser` endpoint resolves the target from
 * the session, so no user id crosses the boundary. The admin user directory
 * (`/settings/users`) remains a separate, admin-gated surface.
 *
 * Writes go through `auth.api.updateUser` rather than Drizzle: ADR-0020 keeps
 * the auth tables mutated only by Better Auth's own operations.
 *
 * Not audited. `audit_events` records domain/business writes (entities,
 * connections, settings, secrets); a user editing their own name is
 * authentication-profile data, and Better Auth owns that lifecycle.
 */
export const updateProfile = createServerFn({ method: 'POST' })
  .inputValidator(updateProfileInput)
  .handler(async ({ data }): Promise<SessionInfo['user']> => {
    const [{ getAuth }, { requireSession }, { getRequestHeaders }] = await Promise.all([
      import('@/server/auth'),
      import('@/server/admin'),
      import('@tanstack/react-start/server')
    ]);
    await requireSession();

    const name = [data.firstName, data.lastName].filter(Boolean).join(' ');
    const headers = getRequestHeaders();
    await getAuth().api.updateUser({
      headers,
      body: {
        name,
        image: data.imageUrl,
        displayName: data.displayName
      }
    });

    const session = await getAuth().api.getSession({
      headers,
      query: { disableCookieCache: true }
    });
    if (!session) {
      // Only reachable if the session vanished between the two calls.
      throw new Error('Session expired while saving your profile');
    }
    return {
      id: session.user.id,
      name: session.user.name,
      displayName: readDisplayName(session.user),
      email: session.user.email,
      image: session.user.image ?? null
    };
  });

/**
 * Which login paths bootstrap config enables, plus whether each may create a
 * new account. Booleans only, never secrets.
 */
export const fetchLoginPaths = createServerFn({ method: 'GET' }).handler(
  async (): Promise<LoginPaths> => {
    const [{ getLoginPaths, getAuthDb }, { installationHasAdmin, readProvisioningPolicy }] =
      await Promise.all([import('@/server/auth'), import('@loxep/auth')]);
    const paths = getLoginPaths();
    const db = getAuthDb();
    const [policy, hasAdmin] = await Promise.all([
      readProvisioningPolicy(db),
      installationHasAdmin(db)
    ]);
    return {
      ...paths,
      newAccounts: {
        magicLink: !hasAdmin || policy.newUsers.magicLink === 'open',
        oidc: !hasAdmin || policy.newUsers.oidc === 'open'
      }
    };
  }
);
