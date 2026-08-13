---
title: Connecting Cloudflare
---

A Cloudflare account connects with a **scoped API token** — never the legacy global API key. There is no consent screen and no installation-wide setup: each Cloudflare account is one connection.

This connection is not a channel Loxep polls for marketplace or store activity. It authenticates the [Infrastructure control plane](../../architecture/infrastructure-control-design/): once connected, it reads a domain's DNS records at Cloudflare, computes the record set your configuration implies, and — through a periodic drift sweep — flags anything at the provider that no longer matches. Applying changes and managing individual domains is a later milestone's `/infrastructure` workspace; today, this page only gets the account connected.

## What you will need

- **Admin access** to the Cloudflare account (or a user with permission to create scoped API tokens on it).
- **Administrator access** to the Loxep installation.
- The specific **zone or zones** Loxep should manage, so the token can be scoped to them rather than to the whole account.

## In the Cloudflare dashboard

1. Sign in to the Cloudflare dashboard, then open **My Profile → API Tokens** (or **Manage Account → API Tokens** for a token owned by the account rather than your user).
2. Choose **Create Token**, then use the **Edit zone DNS** template — or build a custom token with **Zone · DNS · Edit** and **Zone · Zone · Read**.
3. Under **Zone Resources**, scope the token to the specific zone(s) Loxep should manage, not to all zones on the account. A token that cannot see a zone fails with an authentication error on that zone rather than a not-found, so it must cover every zone this connection is meant to manage.
4. Continue, review the summary, and choose **Create Token**. Cloudflare shows the token once — copy it before leaving the page.

Cloudflare's own reference is [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

**The legacy global API key is not supported.** It carries every permission on the account with no scoping, and a control plane that edits DNS has no business holding one — Loxep implements the scoped-token scheme only, sent as `Authorization: Bearer <token>`.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Cloudflare account**. The dialog carries a **Where to get these** section repeating the path above.

Fill in:

- **Account name** — how this account is labelled inside Loxep.
- **Account id** — optional. A zone-scoped token can list its own zones without one; leave this blank unless you know you need it.
- **API token** — the scoped token you just created.
- **Economic entity** — optional business attribution. It records which of your businesses the account belongs to and grants no access of any kind.

Save. The account id (if given) is kept as ordinary connection configuration and stays visible; the token is stored application-encrypted and is never displayed again.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication is refused | The token was scoped to the wrong zone, revoked, or regenerated. Create a new one scoped to the zones Loxep needs. |
| A specific zone returns an authentication error rather than a normal read | The token exists and works, but was never scoped to that zone. Edit the token's **Zone Resources** in Cloudflare to add it. |
| DNS records for one zone never update | Check the zone's own `hosting_targets`/`managed_domains` configuration once the `/infrastructure` workspace ships — a connected account with no zone assigned to it has nothing to reconcile. |

## Never-proxy records

Whatever domains this connection ends up managing, Loxep never proxies a **mail** record — the MX record, the SPF TXT record, DKIM CNAMEs, and the DMARC CNAME a mail provider needs are always applied with proxying turned off, enforced both by the reconciler and by a database constraint. If you use Cloudflare's dashboard yourself to add or edit these records ahead of Loxep, Cloudflare's own guidance for DKIM and DMARC records is to set them **DNS only** — turning the orange cloud off — for exactly the same reason: a proxied mail record breaks delivery outright rather than merely working differently. See [Connecting Purelymail](../connecting-purelymail/#never-proxy-a-mail-record) for the exact record set.

## Removing an account

Removing a Cloudflare connection has two outcomes, and the stored data decides which one you get.

- **Delete** is available when nothing in Loxep references the account. The connection and the encrypted token are removed outright.
- **Archive** is what happens instead once the account has produced anything — managed domains, reconcile runs, or provenance records. Nothing is deleted: the account is retired, disappears from pickers, and is skipped by the drift sweep, while everything it produced keeps resolving.

Open the account's row menu on **Settings → Connections** and choose **Delete**. If anything references it, Loxep refuses, lists exactly what is in the way with counts, and offers **Archive instead**. **Archive** is also available directly.

Archiving is reversible: **Unarchive** returns the account to **Disabled** rather than straight to **Active**. Revoking the API token is a separate step in the Cloudflare dashboard.

## Related

- [Connecting Purelymail](../connecting-purelymail/) — the mail-hosting half of the Infrastructure control plane.
- [Infrastructure Control Plane Design (Phase 7)](../../architecture/infrastructure-control-design/) — the reconciler, drift detection, and the record-materialization rules this connection feeds.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
