---
title: Connecting Medusa
---

A Medusa backend connects with a **secret API key** created in the Medusa Admin dashboard. There is no consent screen and no installation-wide setup: each backend is one connection.

## What you will need

- **Admin access** to the backend's Medusa Admin dashboard.
- **Administrator access** to the Loxep installation.
- The backend's **server root URL** — `https://commerce.example.com`, not the `/admin` API path.

## In the Medusa admin dashboard

1. Sign in to the Medusa Admin dashboard as an admin user.
2. Open **Settings → Secret API Keys**. Older dashboards group the same screen under **Settings → Developer → API key management**; if the labels differ from these, look for the API-key area within Settings.
3. Choose **Create**, name the key something you will recognise, and confirm.
4. Copy the generated key before closing the dialog. Medusa shows it once and cannot display it again.

Medusa's own reference is [Secret API keys](https://docs.medusajs.com/user-guide/settings/developer/secret-api-keys).

Note that Medusa does not scope secret API keys read-only the way a WooCommerce key pair can be scoped. The key carries whatever admin access the backend grants, so treat it accordingly and keep it to backends you control. Loxep itself only ever reads.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Medusa backend**. The dialog carries a **Where to get these** section repeating the path above.

Fill in:

- **Backend name** — how the backend is labelled inside Loxep.
- **Backend URL** — the server root, including `https://`.
- **Secret API key** — the key you just created.
- **Economic entity** — optional business attribution. It records which of your businesses the backend belongs to and grants no access of any kind.

Save. The backend URL is kept as ordinary connection configuration and stays visible; the key is stored application-encrypted and is never displayed again.

## When it does not work

| Symptom | Usual cause |
|---|---|
| The URL is rejected before anything is sent | The backend URL must be a full URL including `https://`. |
| Requests 404 | The URL includes `/admin` or another path. Give the server root only. |
| Authentication is refused | The key was revoked, or it belongs to a different backend. Create a new one. |

## Related

- [Connecting eBay](../connecting-ebay/) and [Connecting WooCommerce](../connecting-woocommerce/) — the other provider setups.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
