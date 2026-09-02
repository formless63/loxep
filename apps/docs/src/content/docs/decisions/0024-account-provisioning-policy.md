---
title: "ADR-0024: Account Provisioning Policy"
---

**Status:** Accepted 2026-08-15 (`loxep-x2s`). Both sub-decisions flagged **PROVISIONAL** below were **CONFIRMED by owner ruling on 2026-08-15 (`loxep-yk8`)**: decision 2's closed-after-bootstrap default and decision 6's `applyOn: 'create'` default both ship exactly as built, with no split default and no precedence change. The owner's ruling also added the two follow-on pieces that make the confirmed default legible rather than silent: an onboarding surface (below) surfacing the choice to open OIDC provisioning right after the first admin exists, and — unrelated to this ADR's provisioning policy but decided in the same ruling — `LOXEP_OIDC_EMAIL_CLAIM`, a bootstrap override for which id_token claim carries the email address (`configuration-and-secrets.md`). Refines ADR-0007 (Better Auth with OIDC and magic links) and ADR-0016 (runtime configuration and secret storage); supersedes nothing. Does not change ADR-0017's two-role model — `admin` and `member` remain the only roles, and nothing here introduces an ACL engine, an invite table, or a per-resource permission.

Shipped in `@loxep/auth` (`provisioning-policy.ts`, `oidc-claim-roles.ts`, the `createAuth` hook wiring), `@loxep/domain`'s `authProvisioningSetting`, the `/settings/users` surface, and — for the ruling recorded above — the `/dashboard/overview` onboarding card (`auth.onboarding_oidc_prompt_dismissed`). Operator documentation: [Managing access](../../guides/managing-access/).

## Context

Loxep auto-provisions. Any address that can receive a magic-link email, and any identity the configured OIDC issuer will authenticate, becomes a `member` account on first sign-in with no policy in between. The only provisioning control that exists is ADR-0016's first-admin bootstrap, and that one only decides *who gets `admin`*, never *who gets an account*.

That was acceptable while every deployment sat behind a network bypass. It stops being acceptable the moment a deployment is reachable, and three separate holes appear at once:

1. **Anyone who can reach `/auth/sign-in` can mint themselves a member account.** `member` is not a spectator role — it reads ordinary product data across the whole installation (implementation contract, *Authentication and authorization*).
2. **The magic-link endpoint will send mail to any address on request.** Even without a resulting account, that is an unauthenticated "make this server email a stranger" primitive.
3. **The IdP's own group/role information is discarded.** An installation whose identity provider already knows who the administrators are must re-designate them by hand in Loxep, and the deployment-level role can silently drift from the IdP's.

Better Auth ships static answers to (1) — `magicLink({ disableSignUp })` and the generic-OAuth provider's `disableSignUp` / `disableImplicitSignUp`. Verified against the installed **better-auth 1.7.2**, all three are read from the plugin options object at request time but are plain booleans fixed at construction; none accepts a function or a context. Using them would make provisioning policy a bootstrap fact requiring a container restart to change, which is exactly the shape ADR-0016 forbids for ordinary runtime policy.

## Decision

**Provisioning policy is one registered application setting, `auth.provisioning`, enforced inside `@loxep/auth` at Better Auth's own database hooks — never in the web layer, and never as a construction-time plugin option.**

### 1. The policy model

```text
auth.provisioning
├── newUsers
│   ├── magicLink   'open' | 'closed'
│   └── oidc        'open' | 'closed'
├── magicLinkEmailDomains   string[]   (empty = no restriction)
└── oidcAdminClaim
    ├── claim        string | null     (dotted path; null = mapping disabled)
    ├── adminValues  string[]
    └── applyOn      'create' | 'every_sign_in'
```

Provisioning is expressed **per method and nowhere else**. There is deliberately no separate master `open`/`closed` switch on top of the two per-method values: one switch plus two refinements is two representations of one fact, and the surfaces would have to keep them consistent forever. "Signups are closed" is the derived statement `magicLink === 'closed' && oidc === 'closed'`.

The setting governs **account creation only**. It never affects a user who already exists: an existing member always keeps their sign-in path, whatever the policy says and whatever their email domain is. That single rule is what makes the whole feature lockout-proof — see *Consequences*.

### 2. Defaults, and the bootstrap window (**CONFIRMED**, 2026-08-15, `loxep-yk8`)

The shipped default is **closed for both methods**, with no domain restriction and no claim mapping:

```json
{
  "newUsers": { "magicLink": "closed", "oidc": "closed" },
  "magicLinkEmailDomains": [],
  "oidcAdminClaim": { "claim": null, "adminValues": [], "applyOn": "create" }
}
```

A closed default cannot be the whole story, because a brand-new installation has nobody to open it. The resolution is a **derived bootstrap window**:

> While the installation has **no `admin` user at all**, new-user provisioning is force-open for every method and the domain allowlist is not applied. From the moment one `admin` exists, the stored `auth.provisioning` policy governs.

The window is keyed on "an admin exists", not on ADR-0016's `auth.first_admin_bootstrap` marker, and that difference is load-bearing: an installation that never sets `LOXEP_BOOTSTRAP_ADMIN_EMAIL` never writes that marker, so a marker-keyed window would never close and the stored policy would be permanently unreachable. Keyed on the admin row instead, every path that produces a first administrator — bootstrap email, `loxep admin promote`, or an OIDC claim mapping — closes the window, and no path can brick a deployment into having no way in.

**CONFIRMED, owner ruling 2026-08-15 (`loxep-yk8`), resolving the question `loxep-x2s` was filed to ask.** Closed-after-bootstrap ships exactly as built: closed for both `magicLink` and `oidc`, no split default. The recommendation stood because `member` reads real business data and because the alternative default is unrecoverable in the direction that matters: an install that was open when it should have been closed has already handed out accounts, while an install that was closed when it should have been open costs its owner one switch. It remains a **behavior change for an upgrade in place** — an existing installation that adds a colleague next week will find the sign-in silently declined until an admin either opens the method or creates the account — and it runs against this repo's own "an absent setting must not surprise an existing install" habit (`integrationsEnabledSetting`, `orderPayloadRetentionSetting`); the ruling accepts that trade explicitly rather than papering over it. The sub-question was whether **`oidc` should default to `open`** while `magicLink` defaults to `closed`: with SSO the operator's identity provider is already the gate, and "add the user in Pocket ID, they sign in" is what every other self-hosted app does. **The ruling keeps the split rejected** — one coherent default ("Loxep does not create accounts for people you did not invite") is still easier to reason about than a two-speed one — and instead addresses the discoverability gap the split was trying to solve with a new onboarding surface: right after the first administrator exists, `/dashboard/overview` shows a dismissible card offering to flip `newUsers.oidc` to `open`, so an operator running SSO learns the option exists without Loxep silently choosing it for them. The card is shown only while OIDC is bootstrap-configured and `newUsers.oidc` is still `closed`; dismissal is permanent, tracked by the additive `auth.onboarding_oidc_prompt_dismissed` setting, independent of `auth.provisioning` itself.

### 3. Enforcement points, both methods

Enforcement is defense in depth at two layers, both inside `createAuth`, so no web-layer caller can forget them. Every claim below was re-verified against the installed better-auth 1.7.2 sources.

**Layer 1 — before the magic link is sent.** The `sendMagicLink` callback resolves the policy and returns *without sending* when the address has no existing user and the policy declines it. `/sign-in/magic-link` returns `ctx.json({ status: true })` regardless (`plugins/magic-link/index.mjs:98`), so the response is identical either way and the endpoint does not become an account-existence oracle. This is the layer that closes hole (2): a closed or allowlisted installation will not send mail to a stranger at all.

**Layer 2 — `databaseHooks.user.create.before`.** This is the authoritative gate, and it covers **both** methods because both reach it:

- magic link: `magicLinkVerify` → `internalAdapter.createUser` → `createWithHooks(..., "user")` (`plugins/magic-link/index.mjs:160`, `db/internal-adapter.mjs:94`);
- OIDC: `/callback/:id` → the social-provider callback flow → `internalAdapter.createOAuthUser` → the same create hooks.

The hook receives `(user, context)` where `context.path` is the *declared endpoint path* (`api/dispatch.mjs:199`), which is what lets one hook apply the right method's policy:

| `context.path` | policy applied | rejection mechanism | what the person sees |
| --- | --- | --- | --- |
| `/magic-link/verify` | `newUsers.magicLink` + domain allowlist | `return false` | redirect to `errorCallbackURL?error=failed_to_create_user` |
| `/callback/:id` | `newUsers.oidc` | `throw new APIError('FORBIDDEN', { code: 'SIGNUP_DISABLED', … })` | redirect to `errorURL?error=SIGNUP_DISABLED&error_description=…` |
| `/admin/create-user` | **allowed** — the escape hatch | — | — |
| anything else / `null` | blocked only when both methods are closed | `return false` | — |

The two rejection mechanisms are different **because the two call sites treat them differently**, not out of preference. `createWithHooks` aborts the insert when `before` returns `false` (`db/with-hooks.mjs:17`); on the magic-link path that surfaces as a clean redirect, while a thrown `APIError` is caught by nothing and renders raw JSON into a browser `GET`. On the OAuth path the reverse holds: `false` produces a downstream `TypeError` that degrades to a misleading `?error=unable_to_create_user`, while an `APIError` carrying a `body.code` is turned into a precise redirect (`plugins/generic-oauth/routes.mjs:286`). Each path gets the mechanism that produces a legible outcome on that path.

Both sign-in calls pass `errorCallbackURL: '/auth/sign-in'`, so a declined sign-in lands back on the sign-in page with a readable message instead of Better Auth's default `/api/auth/error` page.

### 4. The escape hatch: admins create users

Closed means closed — there is **no invite system in this milestone**, no invitation table, and no token to mail. Instead, `/settings/users` gains a **New user** dialog backed by Better Auth's admin plugin (`POST /admin/create-user`). Verified: its `password` field is optional and explicitly documented for "magic link or social login only users" (`plugins/admin/routes.mjs:108-117, 203-210`), so it works with `emailAndPassword.enabled: false`. The created row is an ordinary user; the person then signs in through whichever method they normally would, and because they now *exist*, both enforcement layers pass them through untouched.

That endpoint runs the same `user.create.before` hook, which is precisely why the hook allows `/admin/create-user` unconditionally. Shell recovery remains `loxep admin promote`.

### 5. Magic-link email-domain allowlist

`magicLinkEmailDomains` is a list of bare domains (`example.com`), matched case-insensitively against the part after the last `@`, exact match only — `sub.example.com` is not covered by `example.com`, because a silent subdomain wildcard in a security allowlist is the kind of generosity nobody asks for. An empty list means no restriction.

It is a **provisioning** control, so it is applied only to addresses with no existing user, at both enforcement layers. Consequently it can never lock anybody out, including the admin who typed it wrong.

### 6. OIDC claim-to-role mapping, and its precedence rule (**CONFIRMED**, 2026-08-15, `loxep-yk8`)

`oidcAdminClaim.claim` is a dotted path into the id_token claims (`groups`, `realm_access.roles`); a user whose claim value matches any entry in `adminValues` — case-insensitive, over a string, an array of strings, or a space-delimited string — is an administrator per the IdP. Only `admin` is ever mapped: ADR-0017's two roles mean the mapping is a predicate, not a role table.

Claims are read by decoding the `account.idToken` JWT payload that Better Auth persisted during the callback (`db/get-tables.ts:263`; the value is stored in plaintext and refreshed on each sign-in via `updateAccount`, `oauth2/link-account.mjs:52-64`). It is not re-verified, because it is the token the callback already validated and Loxep is reading its own row. The signature is deliberately not trusted for anything else.

**Precedence, in order:** first-admin bootstrap > claim mapping > the stored role.

- `applyOn: 'create'` (**the default**) — the mapping runs once, in `databaseHooks.account.create.after`, when the OIDC account row is first written. It can only ever *grant* `admin`. Every later sign-in leaves the role exactly as Loxep last set it, so a deliberate promotion or demotion inside Loxep is permanent. This is the recommended setting and mirrors the existing `mapProfileToUser`/`overrideUserInfo: false` stance: **the provider seeds a user at creation and never re-syncs after.**
- `applyOn: 'every_sign_in'` — the operator declares the IdP authoritative. The mapping runs in `session.create.after`, *after* `runFirstAdminBootstrap`, and both grants and revokes `admin` to match the claim. Two guards survive that choice: the mapping is **skipped entirely for the session in which the first-admin bootstrap grant just happened** (otherwise a claim-less bootstrap admin would be demoted in the same request that promoted them, and the deployment could never be bootstrapped), and it **never demotes the only remaining administrator**.

**CONFIRMED, owner ruling 2026-08-15 (`loxep-yk8`): claim-to-role mapping stays exactly as built.** Defaulting `applyOn` to `'create'` — manual role edits win over the IdP unless the operator says otherwise — ships as the recommendation, unchanged: it is the conservative reading of "never override a manual demotion", and the every-sign-in mode exists so an installation that wants the opposite can say so explicitly rather than by accident. The ruling touches neither this precedence (first-admin bootstrap > claim mapping > stored role) nor the mechanism (`account.create.after` for `create`, `session.create.after` for `every_sign_in`, both guards intact). It is unrelated to `LOXEP_OIDC_EMAIL_CLAIM` (a separate bootstrap override documented in `configuration-and-secrets.md`, decided in the same ruling batch) — that knob picks which claim seeds the *email address*; nothing here about which claim (or value) grants `admin` changed.

**Known limitation, documented rather than papered over:** Loxep requests `openid profile email` only, so a claim the issuer emits *only* when an extra scope is requested is invisible to the mapping, which then does nothing. Extra scopes are provider-registration configuration built at `createAuth()` time from bootstrap config; making them settable at runtime is a separate change and is not in this milestone. When `account.idToken` is absent (an issuer whose `getUserInfo` fell back to the userinfo endpoint), the mapping is a no-op for the same reason.

### 7. Where the definition lives, and the one duplication

The Zod definition — key, schema, description, default — lives in `@loxep/domain`'s `settings-defaults.ts` with every other registered setting, because `SettingsService.list()` and `/settings/application` can only show what the *process rendering them* registered.

`@loxep/auth` cannot import it: the package's dependencies are `@loxep/config`, `@loxep/db`, `better-auth`, and `nodemailer`, and it carries no Zod. It therefore reads the `application_settings` row directly — exactly as `first-admin.ts` already reads its own marker — through a hand-written **total** parser that substitutes the documented default for any field it cannot make sense of. The shape is stated twice; the domain definition is authoritative, the auth parser is a defensive mirror, and both carry a comment pointing at the other. This is the same trade `ebayRateBudgetSetting`, `wooRateBudgetSetting`, and `cloudflareRateBudgetSetting` already make when they duplicate an adapter's literals rather than invert a package dependency. Because the parser is total and conservative, drift can only ever make the auth layer *more* restrictive than the operator's stored value, never less.

## Alternatives rejected

**Better Auth's native `disableSignUp` options.** The obvious answer, and it fails the ADR-0016 test. All three (`magicLink.disableSignUp`, provider `disableSignUp`, provider `disableImplicitSignUp`) are booleans fixed when `betterAuth()` is constructed — verified: none is typed as a function and none receives a context, unlike the neighbouring `authorizationUrlParams`, which is. Wiring them to a database value would mean either restarting the container to change provisioning policy, or mutating the live plugin options object from outside (`plugins/generic-oauth/routes.mjs:145` does re-read the config array per request, which is undocumented, untyped, and not something a security control should stand on). Rejected on both counts.

**Enforcing in the web layer** — a check inside the sign-in server function, or a TanStack route guard. Rejected for the reason `first-admin.ts` already states about the bootstrap grant: a rule that lives in one caller can be forgotten by the next one. `/api/auth/*` is a catch-all mount, so anything reaching Better Auth directly would bypass it entirely.

**An invite system** (invitation rows, tokenised invite emails, a pending-invite table). Rejected for this milestone as more machinery than the problem needs: an admin plugin `createUser` call plus the ordinary sign-in flow already gets a named person an account, with no new table, no new token lifecycle, and no second class of half-existing user to reason about. It stays available as a later, separate decision if a real workflow asks for it.

**`open` / `invite-only` / `closed` as a three-state mode**, as the bead's own wording suggested. Rejected: with no invite system, `invite-only` and `closed` denote the same enforcement — nobody self-provisions, an admin creates the account — and shipping two names for one behavior only invites a later reader to assume there is a difference.

**A single master switch plus per-method refinements.** Rejected as redundant state; see decision 1.

**Keying the bootstrap window on ADR-0016's `auth.first_admin_bootstrap` marker.** Rejected: it never gets written on an installation without `LOXEP_BOOTSTRAP_ADMIN_EMAIL`, which would leave that installation permanently in the open window and its stored policy permanently inert. "An admin exists" is the condition actually meant.

**Restricting the bootstrap window to the configured bootstrap-admin address** (only that email may create an account until it has signed in). Genuinely more restrictive, and rejected reluctantly: it makes an installation with no bootstrap address unusable from a cold start, which converts an optional environment variable into a required one and pushes the recovery path onto the CLI for a case that is currently self-service.

**Applying the domain allowlist to every magic-link send, existing users included.** Rejected: it is the only version of this feature that can lock a real administrator out — misspell your own domain and the door closes behind you. Restricted to account creation, the allowlist is a provisioning control with no lockout mode, and the anti-relay benefit is unaffected because unknown addresses are exactly what it refuses.

**Returning an error to the browser when a closed installation is asked to mail an unknown address.** Rejected as an account-existence oracle. The sign-in page states the policy up front instead, which tells a legitimate newcomer what to do without telling a stranger who already has an account.

**Reading OIDC claims through `mapProfileToUser`.** It sees the richest object — the full merged profile — but it is handed no endpoint context and no user id, fires before the user exists, and would need a request-scoped side channel to reach the role write. Rejected in favour of the persisted `account.idToken`, which the account-create/update hooks receive directly with the user id already in hand. The cost is the scope limitation recorded in decision 6.

**Declaring the claim as a Better Auth `user.additionalFields` entry** so it flows into `user.create.before`. This is the supported route for getting one specific claim into that hook, and it was rejected because it is a schema change (ADR-0020: the generator owns the auth model, so a new column means a generate + migration) in service of a setting whose whole point is that the claim name is operator-chosen at runtime.

**Storing the mapped role as a Loxep-owned column separate from `user.role`.** Rejected: two role columns, one precedence question per read, and ADR-0007's explicit instruction not to build a parallel role system beside Better Auth's.

## Consequences

- **No migration.** The policy is an `application_settings` row and the roles are the two that already exist.
- **This feature cannot lock anyone out.** Every control is scoped to account *creation*: existing users sign in regardless of policy, regardless of domain allowlist, regardless of claim configuration. The one hazard worth warning about in the UI is therefore not the allowlist but `applyOn: 'every_sign_in'` with an `adminValues` list that omits your own group — and even that is caught by the last-administrator guard.
- **A new deployment's first sign-in still just works**, through the bootstrap window, and closes behind itself.
- **An upgrade in place changes behavior for new people only.** No existing session, user, or role is touched by the default. This is the cost the provisional flag is about.
- **`fetchLoginPaths` now reads the database.** It was previously a pure bootstrap-config read on an unauthenticated route; it now also reports whether new accounts are open, which is a deliberate disclosure — it is the message the sign-in page needs to show a newcomer, and it says nothing about any individual account.
- **`@loxep/auth` writes `user.role` directly** for the claim mapping, as `first-admin.ts` already does for the bootstrap grant. A database hook has no session to call `auth.api.setRole` with; the write stays in these two audited places and nowhere else.
- **Enforcement is per-request and uncached.** Each affected request costs one indexed `application_settings` lookup and, in the bootstrap window check, one bounded `user` lookup. These happen on sign-in and account creation, not on ordinary page loads, so no cache is warranted and none is introduced — a stale provisioning policy is precisely the thing this ADR should not ship.
