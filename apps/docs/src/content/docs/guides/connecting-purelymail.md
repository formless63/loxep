---
title: Connecting Purelymail
---

A Purelymail account connects with an **API token** generated in its own account settings. There is no consent screen and no installation-wide setup: each Purelymail account is one connection.

This connection is not a channel Loxep polls for marketplace or store activity. It authenticates the [Infrastructure control plane](../../architecture/infrastructure-control-design/)'s mail-hosting milestone: once connected, Loxep can register a mail domain, poll for the ownership code and delegation it needs, and sync mailboxes from a template. Declaring domains and templates is a later milestone's `/infrastructure` workspace; today, this page only gets the account connected.

## What you will need

- **Access** to the Purelymail account whose API you want Loxep to use.
- **Administrator access** to the Loxep installation.

## In your Purelymail account

1. Sign in to your Purelymail account.
2. Open the account's API settings and generate a new API token. Purelymail's dashboard labels this area differently across accounts — look for an API or developer-access section of account settings.
3. Copy the token before leaving the page. Purelymail shows it once and cannot display it again.

**Purelymail tokens are not scoped.** Unlike Cloudflare's API tokens, there is no way to narrow a Purelymail token to specific domains or operations — the one token can do everything the API exposes, including deleting a domain. Treat it as full access to that Purelymail account and keep it to one you control. Loxep itself only registers domains, polls delegation, and syncs mailboxes from the template you configure — it never sends or reads mail through this connection.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Purelymail account**. The dialog carries a **Where to get these** section repeating the path above.

Fill in:

- **Account name** — how this account is labelled inside Loxep.
- **API token** — the token you just created.
- **Economic entity** — optional business attribution. It records which of your businesses the account belongs to and grants no access of any kind.

Save. Purelymail exposes no account identifier of its own — the token *is* the account — so there is no configuration to keep visible here; the token itself is stored application-encrypted and is never displayed again.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Authentication is refused | The token was revoked or regenerated. Purelymail's own failure message for a bad or missing token names the `Purelymail-Api-Token` header itself — generate a new token and reconnect. |
| The response looks successful but nothing happened | Purelymail answers every call with HTTP 200, including failures — the error is in the response body, not the status code. This is expected of the provider and Loxep's adapter already branches on the response envelope, not the status, so a genuine failure still surfaces as an error in Loxep. |
| Ownership verification never completes | Loxep never polls ownership until the DNS provider (e.g. the paired Cloudflare connection) reports the zone's delegation as active — see the design's **delegation gate**. Confirm the domain's nameservers actually point at the DNS provider before expecting progress here. |

## Never-proxy a mail record

Whatever domain this connection ends up managing, Loxep computes the exact DNS record set Purelymail requires and applies it — through the paired DNS connection — with proxying always turned off:

- **MX** — `@` → `mailserver.purelymail.com`, priority 50.
- **SPF** — a TXT record on `@`: `v=spf1 include:_spf.purelymail.com ~all`.
- **Ownership** — a TXT record on `@` holding the ownership code Purelymail issues (per account, not per domain).
- **DKIM** — **three** CNAME records: `purelymail1._domainkey`, `purelymail2._domainkey`, and `purelymail3._domainkey`, each pointing at the matching `key{1,2,3}.dkimroot.purelymail.com`. Purelymail rotates all three keys, so publishing fewer than three makes outgoing mail verify only intermittently — a proxied or missing key looks identical to a rotation nobody noticed.
- **DMARC** — a **CNAME**, not the more common TXT policy record: `_dmarc` → `dmarcroot.purelymail.com`.

**None of these may ever be proxied through Cloudflare or any other CDN.** A proxied MX record cannot receive mail at all, and a proxied DKIM or DMARC record breaks signature verification — Purelymail's own Cloudflare instructions independently say to set these records **DNS only, "this is very important."** Loxep's reconciler enforces `proxied = false` for every mail record it materializes, and the schema backs that with a database constraint, so this is not something the operator has to remember to do by hand once a domain is declared — it is stated here because the DNS side of that domain is configured in [Connecting Cloudflare](../connecting-cloudflare/), a separate connection from this one, and a manual edit there is the one way to accidentally re-enable proxying on a record Loxep otherwise protects.

## Removing an account

Removing a Purelymail connection has two outcomes, and the stored data decides which one you get.

- **Delete** is available when nothing in Loxep references the account. The connection and the encrypted token are removed outright.
- **Archive** is what happens instead once the account has produced anything — mail domains, mailboxes, or provenance records. Nothing is deleted: the account is retired, disappears from pickers, and is skipped by any future sync, while everything it produced keeps resolving.

Open the account's row menu on **Settings → Connections** and choose **Delete**. If anything references it, Loxep refuses, lists exactly what is in the way with counts, and offers **Archive instead**. **Archive** is also available directly.

Archiving is reversible: **Unarchive** returns the account to **Disabled** rather than straight to **Active**. Revoking the API token is a separate step in your Purelymail account settings.

## Related

- [Connecting Cloudflare](../connecting-cloudflare/) — the DNS half of the Infrastructure control plane; the connection whose zone this domain's records are applied through.
- [Infrastructure Control Plane Design (Phase 7)](../../architecture/infrastructure-control-design/) — mail-domain registration, the delegation gate, and record materialization.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
