/**
 * Better Auth client (browser side). Plugins mirror the server plugin set
 * built by `buildAuthPluginConfig()` (@loxep/db): magic link, generic OAuth
 * (the bootstrap OIDC issuer registers as providerId 'oidc'), and admin.
 * Base URL is same-origin, so no configuration is needed here.
 */
import { createAuthClient } from 'better-auth/react';
import { adminClient, genericOAuthClient, magicLinkClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), genericOAuthClient(), adminClient()]
});
