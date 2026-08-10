---
title: "ADR-0007: Authentication"
---

# ADR-0007: Better Auth with OIDC and magic links

**Status:** Accepted

## Context

Loxep is self-hosted and should support multiple application users without requiring local passwords. Deployments may already operate an OIDC identity provider, while smaller installations need a low-friction email-based login path.

## Decision

Use Better Auth as the application authentication framework.

Initial supported authentication methods:

- generic OIDC, with Pocket ID as a primary tested provider;
- email magic links;
- no password authentication.

Authentication identity is separate from external commerce/provider connections. Connecting an eBay account does not create or define a Loxep application user.

Authorization is application-owned and must be capable of granting users different access to external connections/resources without introducing SaaS-style tenancy.

## Consequences

- Self-hosters can integrate existing identity infrastructure.
- Password storage/recovery is outside Loxep's scope.
- Email delivery configuration is required for magic-link deployments.
- First-run administrator bootstrap and recovery paths must be explicitly designed before release.
