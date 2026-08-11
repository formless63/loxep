/**
 * @loxep/auth — runtime authentication package (ADR-0007, ADR-0016,
 * ADR-0017, ADR-0020).
 *
 * Exports the explicit Better Auth factory (`createAuth`), deployment-level
 * role guards, magic-link email delivery types, and the first-admin
 * bootstrap. Importing this package never constructs an auth instance.
 */
export {
  buildOidcProviderConfig,
  createAuth,
  OIDC_PROVIDER_ID,
} from "./create-auth.ts";
export type { CreateAuthOptions, LoxepAuth } from "./create-auth.ts";

export {
  createSmtpMagicLinkSender,
} from "./magic-link-email.ts";
export type { MagicLinkEmail, SendMagicLinkEmail } from "./magic-link-email.ts";

export {
  AuthorizationError,
  hasRole,
  LOXEP_ROLES,
  requireRole,
  sessionRoles,
} from "./roles.ts";
export type { LoxepRole, RoleBearingSession } from "./roles.ts";

export {
  FIRST_ADMIN_BOOTSTRAP_SETTING_KEY,
  runFirstAdminBootstrap,
} from "./first-admin.ts";
export type { FirstAdminBootstrapRecord } from "./first-admin.ts";
