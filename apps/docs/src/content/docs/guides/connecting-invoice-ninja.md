---
title: Connecting Invoice Ninja
---

A self-hosted Invoice Ninja instance connects with a **company API token** issued in its own admin settings. There is no consent screen and no installation-wide setup: each instance is one connection.

Unlike eBay, WooCommerce, and Medusa, this connection is not a channel Loxep polls or scans. Invoice Ninja is a **billing companion**: Loxep owns the source facts, the decision that work was billed, the seller and counterparty, and the amounts, while Invoice Ninja owns rendering, delivery, reminders, payment collection, and the customer-visible invoice number. Connecting an instance here only stores its address and credential — pushing an actual invoice is a separate, on-demand action, and is not wired up yet (tracked separately from this connection).

## What you will need

- **Admin access** to the instance's Invoice Ninja settings.
- **Administrator access** to the Loxep installation.
- The instance's **root URL** — `https://billing.example.com`, not the `/api/v1` path.

## In the Invoice Ninja admin

1. Sign in to the instance as an admin user.
2. Open **Settings → Account Management → API Tokens**, then choose **Add token**. If the labels differ from these, look for the API-token area within Account Management settings.
3. Name it something you will recognise and confirm.
4. Copy the generated token before leaving the screen. Invoice Ninja shows it once.

Invoice Ninja does not scope company tokens read-only, so treat the token as full access to that user's company. Loxep only ever pushes invoice drafts and client records it created itself, and never pulls invoice lines back once an invoice is issued — see [Counterparty, Project, Service, and Billing Schema Design](../../architecture/services-billing-schema-design/#the-invoice-ninja-round-trip) for the full round-trip.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Invoice Ninja instance**. The dialog carries a **Where to get these** section repeating the path above.

Fill in:

- **Instance name** — how the instance is labelled inside Loxep.
- **Instance URL** — the site root, including `https://`.
- **API token** — the token you just created.
- **Economic entity** — optional business attribution. It records which of your businesses the instance belongs to and grants no access of any kind.

Save. The instance URL is kept as ordinary connection configuration and stays visible; the token is stored application-encrypted and is never displayed again.

## When it does not work

| Symptom | Usual cause |
|---|---|
| The URL is rejected before anything is sent | The instance URL must be a full URL including `https://`. |
| Authentication is refused (`Invalid token`) | The token was revoked, regenerated, or belongs to a different instance. Create a new one. |
| The instance is unreachable | Invoice Ninja instances are frequently run without a public TLS-terminated address during development; Loxep requires `https://` and will not connect to a plain-`http://` instance. |

## Removing an instance

Removing an instance connection has two outcomes, and the stored data decides which one you get.

- **Delete** is available when nothing in Loxep references the instance. The connection and the encrypted token are removed outright.
- **Archive** is what happens instead once the instance has produced anything — pushed invoices, clients, or provenance records. Nothing is deleted: the instance is retired, disappears from pickers, and is skipped by any future push action, while everything it produced keeps resolving.

Open the instance's row menu on **Settings → Connections** and choose **Delete**. If anything references it, Loxep refuses, lists exactly what is in the way with counts, and offers **Archive instead**. **Archive** is also available directly.

Archiving is reversible: **Unarchive** returns the instance to **Disabled** rather than straight to **Active**. Revoking the API token is a separate step in the Invoice Ninja admin.

## Related

- [Connecting eBay](../connecting-ebay/), [Connecting WooCommerce](../connecting-woocommerce/), and [Connecting Medusa](../connecting-medusa/) — the other provider setups.
- [Counterparty, Project, Service, and Billing Schema Design](../../architecture/services-billing-schema-design/) — what Loxep owns versus what Invoice Ninja owns, and why.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
