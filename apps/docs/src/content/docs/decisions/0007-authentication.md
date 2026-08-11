---
title: "ADR-0007: Better Auth with OIDC and magic links"
---

**Status:** Accepted; initial authorization model superseded by ADR-0017; schema ownership and user-reference policy defined by ADR-0020.

## Context

Loxep is self-hosted and should support multiple application users without requiring local passwords. Deployments may already operate an OIDC identity provider, while smaller installations need a low-friction email-based login path.

## Decision

Use Better Auth as the application authentication framework.

Initial supported authentication methods:

- generic OIDC, with Pocket ID as a primary tested provider;
- email magic links;
- no password authentication.

Authentication identity is separate from external commerce/provider connections. Connecting an eBay account does not create or define a Loxep application user.

### Authorization boundary

Better Auth owns authentication/session state and deployment-level roles such as:

```text
admin
member
```

using its current supported admin/access-control capabilities.

Loxep owns resource/business authorization, such as whether a particular user may `owner`, `manage`, or `view` a specific external connection.

Do not create a parallel global Loxep role system merely to duplicate Better Auth, and do not force domain-resource permissions into Better Auth metadata.

## Consequences

- Self-hosters can integrate existing identity infrastructure.
- Password storage/recovery is outside Loxep's scope.
- Email delivery configuration is required for magic-link deployments.
- First-run administrator bootstrap and recovery paths must be explicitly designed before release.
- Application-global roles and Loxep domain permissions have a clear ownership boundary.
