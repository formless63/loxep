---
title: Connecting WooCommerce
---

A WooCommerce store connects with a **read-only REST API key pair** issued by the store itself. There is no consent screen and no installation-wide setup: each store is one connection, and you can connect as many stores as you run.

## What you will need

- **Administrator or shop-manager access** to the store's WordPress admin. Loxep cannot create the key for you.
- **Administrator access** to the Loxep installation.
- The store's **site root URL** — `https://store.example.com`, the address a customer would visit. Not the `/wp-json/` REST path and not the `/wp-admin/` path.

The store must also meet two WooCommerce requirements for its REST API to answer at all: pretty permalinks enabled, and the site served over HTTPS. Both are normal for a live store; a local development store with plain permalinks will fail to connect for that reason rather than anything to do with Loxep.

## In the WordPress admin

1. Sign in to the store's WordPress admin.
2. Go to **WooCommerce → Settings → Advanced → REST API**.
3. Choose **Add key**.
4. Complete the form:
   - **Description** — something you will recognise in six months, for example `Loxep`. It is only a label.
   - **User** — the WordPress user the key acts as. An administrator account is the usual choice; the key can never do more than that user could.
   - **Permissions** — **Read**.
5. Choose **Generate API key**.

WooCommerce then shows the **consumer key** (`ck_…`) and **consumer secret** (`cs_…`) exactly once. Copy both before leaving the screen. If you lose either half, revoke the key and generate a new one — there is no way to display it again.

### Why read-only

Loxep's provider ingestion is read-only by design: it observes orders and products and writes nothing back. A read/write key would grant Loxep the ability to modify your catalogue and orders without buying any capability it uses. Choose **Read** every time.

WooCommerce's own reference is [WooCommerce REST API](https://woocommerce.com/document/woocommerce-rest-api/).

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add WooCommerce store**. The dialog carries a **Where to get these** section repeating the path above.

Fill in:

- **Store name** — how the store is labelled inside Loxep. A local label; it need not match the shop's title.
- **Store URL** — the site root, including `https://`.
- **Consumer key** and **Consumer secret** — the pair you just generated.
- **Economic entity** — optional business attribution. It records which of your businesses the store belongs to and grants no access of any kind.

Save. The store URL is kept as ordinary connection configuration and stays visible; the key pair is stored application-encrypted and is never displayed again. Re-entering the credentials later replaces them rather than revealing them.

## When it does not work

| Symptom | Usual cause |
|---|---|
| The URL is rejected before anything is sent | The store URL must be a full URL including `https://`. |
| Authentication fails with correct-looking credentials | The key pair was copied from a different store, or one half was truncated. Revoke and reissue. |
| Requests 404 against the store | The REST API is not reachable — usually plain permalinks, or a security plugin blocking `/wp-json/`. |
| Requests are rejected as unauthorised over plain HTTP | WooCommerce's key-pair authentication requires HTTPS. |
| Reads work but return nothing | The key's user may not be able to see the resources in question. Reissue against an administrator account. |

## Removing a store

Removing a store connection has two outcomes, and the stored data decides which one you get.

- **Delete** is available when nothing in Loxep references the store. The connection and the encrypted key pair are removed outright.
- **Archive** is what happens instead once the store has produced anything — orders, monitors, or provenance records. Nothing is deleted: the store is retired, disappears from pickers, and is skipped by polling, while everything it produced keeps resolving.

Open the store's row menu on **Settings → Connections** and choose **Delete**. If anything references it, Loxep refuses, lists exactly what is in the way with counts, and offers **Archive instead**. **Archive** is also available directly.

Archiving is reversible: **Unarchive** returns the store to **Disabled** rather than straight to **Active**. Revoking the key pair in WooCommerce is a separate step on the WordPress side.

## Related

- [Connecting eBay](../connecting-ebay/) and [Connecting Medusa](../connecting-medusa/) — the other provider setups.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
