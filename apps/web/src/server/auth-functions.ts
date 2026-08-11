/**
 * Server functions bridging the client/router to the server-side auth
 * instance. Handlers use dynamic imports so `@/server/auth` (and the server
 * packages behind it) stay out of the client bundle; only type-only imports
 * from server packages are allowed at the top level here.
 */
import { createServerFn } from '@tanstack/react-start';
import type { LoxepRole } from '@loxep/auth';

export interface SessionInfo {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };
  roles: LoxepRole[];
}

export interface LoginPaths {
  magicLink: boolean;
  oidc: boolean;
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
        email: session.user.email,
        image: session.user.image ?? null
      },
      roles: sessionRoles(session)
    };
  }
);

/** Which login paths bootstrap config enables — booleans only, never secrets. */
export const fetchLoginPaths = createServerFn({ method: 'GET' }).handler(
  async (): Promise<LoginPaths> => {
    const { getLoginPaths } = await import('@/server/auth');
    return getLoginPaths();
  }
);
