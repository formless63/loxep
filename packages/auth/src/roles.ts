/**
 * Deployment-level role guards (ADR-0007, ADR-0017).
 *
 * Better Auth's admin plugin owns the roles; Loxep's only roles are `admin`
 * and `member`, installation-wide. These helpers are the server-side guard
 * later web/server code calls before admin-only operations. There is no ACL
 * engine and no resource-level permission model here by design.
 */

export const LOXEP_ROLES = ["admin", "member"] as const;
export type LoxepRole = (typeof LOXEP_ROLES)[number];

/**
 * Minimal structural shape of Better Auth session data
 * (`auth.api.getSession()` result): the user record carrying the admin
 * plugin's `role` field. Multiple roles are comma-separated per the plugin's
 * storage convention.
 */
export interface RoleBearingSession {
  user: {
    role?: string | null | undefined;
  };
}

/** Thrown by {@link requireRole}; `statusCode` maps onto the HTTP response. */
export class AuthorizationError extends Error {
  readonly statusCode: 401 | 403;

  constructor(message: string, statusCode: 401 | 403) {
    super(message);
    this.name = "AuthorizationError";
    this.statusCode = statusCode;
  }
}

/**
 * Roles carried by the session's user. A missing/empty `role` value counts
 * as `member` — the admin plugin's configured default role — so ordinary
 * membership never depends on a backfill; `admin` is only ever explicit.
 */
export function sessionRoles(
  session: RoleBearingSession | null | undefined,
): LoxepRole[] {
  if (!session) return [];
  const raw = session.user.role;
  if (raw === null || raw === undefined || raw.trim() === "") {
    return ["member"];
  }
  const roles = raw
    .split(",")
    .map((role) => role.trim())
    .filter((role): role is LoxepRole =>
      (LOXEP_ROLES as readonly string[]).includes(role),
    );
  // An unknown stored value still represents an authenticated member.
  return roles.length > 0 ? roles : ["member"];
}

/** Whether the session's user holds `role`. `null`/`undefined` never does. */
export function hasRole(
  session: RoleBearingSession | null | undefined,
  role: LoxepRole,
): boolean {
  return sessionRoles(session).includes(role);
}

/**
 * Guard for server code: throws {@link AuthorizationError} (401 when
 * unauthenticated, 403 when authenticated without `role`), otherwise returns
 * the session unchanged for chaining.
 */
export function requireRole<S extends RoleBearingSession>(
  session: S | null | undefined,
  role: LoxepRole,
): S {
  if (!session) {
    throw new AuthorizationError("Authentication required", 401);
  }
  if (!hasRole(session, role)) {
    throw new AuthorizationError(`Role '${role}' required`, 403);
  }
  return session;
}
