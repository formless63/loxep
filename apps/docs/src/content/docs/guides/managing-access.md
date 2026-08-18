---
title: Managing access
description: Who can sign in to your Loxep installation — the first administrator, the account provisioning policy, adding people, and mapping an identity-provider group to the admin role.
---

Loxep has exactly two roles, installation-wide: **admin** and **member**. A member can use and view ordinary product data across the whole installation; an admin can additionally do installation, security, and administrative work. There is no per-connection or per-workspace permission model, and there are no passwords — people sign in with an emailed magic link or through your identity provider.

This guide covers the three things that decide who gets an account and what role they get.

## 1. The first administrator

A brand-new installation has no users at all. Set `LOXEP_BOOTSTRAP_ADMIN_EMAIL` in your deployment configuration to your own address, start Loxep, and sign in normally. The first successful sign-in matching that address is granted the `admin` role, and Loxep records that the bootstrap is done.

That record is final. Later sign-ins never re-grant the role, even if the variable stays set and even if you deliberately demote yourself afterwards — so leaving the variable in your Compose file does not leave a standing back door.

If you lose administrator access entirely, recover it from a shell on the server:

```bash
docker compose exec loxep node bin/loxep.ts admin list
docker compose exec loxep node bin/loxep.ts admin promote --email=you@example.com
```

There is no hidden web recovery page and no default password.

## 2. Who may create an account

Go to **Settings → Users**. The **Account provisioning** card decides whether somebody who does not yet have an account can create one by signing in.

Two switches, one per sign-in method:

- **Anyone with an email address can create an account** — magic-link self-service. While this is off, Loxep will not even *send* a link to an address that has no account, so a stranger cannot sign themselves up and cannot make your server email them either.
- **Anyone your identity provider authenticates can create an account** — SSO self-service. Turn this on when your identity provider is the gate: everybody it lets through gets a member account on first sign-in. While it is off, SSO sign-in is declined for people who have no account yet.

Both ship **off**. When both are off, the sign-in page says so plainly, so a newcomer is told to ask an administrator rather than left waiting for an email that will never arrive.

:::note[Nothing here can lock anybody out]
Every control on this card governs account **creation** only. People who already have an account keep signing in exactly as before — whatever the policy says, whatever their email domain is, whichever method they use. That includes you.
:::

### The bootstrap window

A closed default would be useless if it meant a fresh installation could never sign anybody in. So while the installation has **no administrator at all**, provisioning is force-open for every configured method and the card shows a *not in force* badge explaining that. The moment a first administrator exists — through the bootstrap variable, through `loxep admin promote`, or through the claim mapping below — your stored policy takes over.

If your installation has SSO configured, the very next visit to the dashboard shows a one-time card offering to turn on SSO self-service right then, instead of leaving you to discover the switch on this page later. It only appears while that method is still closed; dismissing it (with or without turning the switch on) is permanent — it will not come back on a later visit.

### Allowed email domains

Optionally restrict magic-link self-service to your own domains. Enter bare domains (`example.com`, not `@example.com`), one per tag.

Matching is exact: `example.com` does **not** cover `sub.example.com`, so list every domain you actually use. An empty list means no restriction.

Because the list only applies to people who do not have an account yet, a typo here cannot shut you out — it just means your colleagues cannot sign themselves up until you fix it. Loxep warns you when your own email domain is missing from a non-empty list, for exactly that reason.

## 3. Adding people yourself

When new accounts are closed, **Settings → Users → New user** is how you add somebody. Enter their email address, their name, and the role you want them to have.

Two things to know:

- **No password is set and nothing is emailed.** Loxep has no password login. Creating the account simply means the person can now sign in with a magic link or SSO like everybody else — tell them the account is ready.
- **The email address has to match.** For SSO, it must be the address your identity provider reports for them; otherwise their sign-in creates nothing and is declined by the provisioning policy.

Change somebody's role later from the row actions in the same user table. Loxep is deliberately not an invitation system: there are no pending invites to chase and no half-created accounts.

## 4. Revoking a departing user's access

The same row actions in **Settings → Users** cover someone leaving, not just someone joining:

- **Ban** sets a reason (required) and an optional expiry, then immediately revokes every active session for that user — they are signed out everywhere and cannot sign back in, whether they were already logged in or not, until you unban them or the ban expires. You cannot ban your own account, so there is no click path that locks you out of your own installation.
- **Unban** restores the ability to sign in through their normal method. It does not touch any session, since a ban already revoked them all.
- **Sign out everywhere** revokes every session for a user without changing their role or ban state — useful for a reported-lost device or a suspected compromised session when you don't want to ban or demote them.

Promoting or demoting someone also signs them out everywhere as part of the same action, so a role change takes effect on their very next request instead of waiting for their existing session to expire on its own.

## 5. Administrators from your identity provider (optional)

If your identity provider already knows who your administrators are, Loxep can read that instead of you maintaining the role by hand. In the **Account provisioning** card:

- **Claim** — the name of the claim in the OIDC id_token, as a dotted path. `groups` for most providers, `realm_access.roles` for Keycloak. Leave it empty to ignore claims entirely.
- **Values that mean administrator** — one or more claim values, for example `loxep-admins`. Matched case-insensitively; the claim may be an array, a single string, or a space-delimited string.
- **Re-apply on every sign-in** — the important switch. See below.

Only the `admin` role is ever mapped. Loxep has two roles, so this is a yes/no question rather than a role table.

### `create` versus `every sign-in`

**Off (the default and the recommendation).** The claim is read once, when the person's account is first created, and can only ever *grant* admin. Everything you do afterwards in Settings → Users is permanent: if you demote somebody, they stay demoted no matter what their identity provider says next week.

**On.** Your identity provider becomes authoritative in both directions. Every sign-in re-reads the claim: somebody added to the group is promoted, and somebody removed from it is **demoted to member**, including you. Loxep refuses to demote the last remaining administrator as a backstop, but do not rely on it — confirm you are in the group before turning this on. Loxep warns you in the form when this combination is about to be saved.

:::caution[Claim not showing up?]
Loxep requests the `openid profile email` scopes only. If your identity provider emits group information only when an extra scope is requested, Loxep cannot see it and the mapping silently does nothing. Configure your provider to include the claim in the id_token under those scopes; requesting additional scopes from inside Loxep is not supported yet.
:::

## What a declined sign-in looks like

Somebody who is turned away lands back on the sign-in page with a plain explanation — that this installation is not accepting new accounts and an administrator must create theirs.

A magic-link request for an unknown address is a deliberate exception: the page still says "check your email" and no mail is sent. That is intentional. Answering differently for known and unknown addresses would turn the sign-in form into a way to test whether a given person has an account here.

## Where this is stored

The policy is an ordinary database-backed application setting (`auth.provisioning`), so changing it takes effect immediately with no restart, and every change is recorded in the audit log with the administrator who made it. Nothing in it is secret. The full design rationale — including the owner ruling that confirmed these defaults and added the one-time dashboard prompt above — is in [ADR-0024](../../decisions/0024-account-provisioning-policy/).
