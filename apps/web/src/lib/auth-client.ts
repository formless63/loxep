/**
 * Better Auth client (browser side). Plugins mirror the server plugin set
 * built by `buildAuthPluginConfig()` (@loxep/db): magic link and admin.
 * Better Auth 1.7 exposes generic OAuth providers through the standard
 * `signIn.social` client method, so it requires no browser plugin.
 * Base URL is same-origin, so no configuration is needed here.
 */
import { createAuthClient } from 'better-auth/react';
import { adminClient, magicLinkClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [magicLinkClient(), adminClient()]
});
