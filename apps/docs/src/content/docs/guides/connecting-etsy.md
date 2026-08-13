---
title: Connecting Etsy
---

Connecting Etsy splits into the same two pieces eBay does: one **application keyset** that identifies this Loxep installation to Etsy, and one **shop consent** per Etsy shop you want Loxep to observe. The keyset is configured once by an administrator; consent is repeated for each shop. Etsy's version of this flow has two differences worth knowing before you start: there is **no sandbox at all** — every step below happens against the real Etsy site — and Etsy's app-approval step is **owner-gated and cannot be automated**: nothing here can be live-tested until an administrator has registered and been approved for a Developer Portal app.

Work through the sections in order. Everything in "In the Etsy Developer Portal" happens on Etsy's site; everything in "In Loxep" happens on `/settings/integrations` and `/settings/connections`.

## What you will need

- An **Etsy account with two-factor authentication enabled**. The Developer Portal refuses app registration without it.
- **Administrator access** to the Loxep installation.
- The installation's **public address** — the URL people type to reach Loxep. It is the `LOXEP_PUBLIC_ORIGIN` bootstrap value; see [Configuration & Secrets](../../architecture/configuration-and-secrets/). Loxep shows you the exact callback URL derived from it.
- **Patience for Etsy's approval queue.** Etsy reviews every new app before its key activates — typically 24–48 hours, longer if the app description is vague — and the key does nothing at all, including public reads, until approval lands.

## Owner prerequisite (cannot be automated)

This step has to happen before anything else in this guide, and it can only be done by a human with access to a real Etsy account:

1. Enable two-factor authentication on the Etsy account that will own the app.
2. Register a **Personal App** at [Etsy's Developer Portal](https://www.etsy.com/developers/register). You will complete a captcha identity-verification step.
3. Wait for approval — typically 24–48 hours. There is no "pending but readable" tier: the keystring authenticates nothing until Etsy approves the app.
4. Once approved, record the keystring and shared secret from **Your Apps**.
5. Decide on a redirect URI (the next section covers what Loxep needs it to be).

Nothing past this point can be live-tested until steps 1–4 are complete.

## In the Etsy Developer Portal

### Create the app and get its keyset

Sign in to your developer account (the one with 2FA enabled) and open [Your Apps](https://www.etsy.com/developers/your-apps). Once the app you registered shows as approved, note two values:

| Etsy's label | Goes into Loxep as |
|---|---|
| Keystring | Keystring |
| Shared secret | Shared secret |

Treat the shared secret as a password. It authenticates this installation to Etsy on every call, alongside the keystring, as `x-api-key: <keystring>:<sharedSecret>`.

### Register the redirect URI

Unlike eBay, Etsy takes the **literal callback URL** as the OAuth redirect target — there is no RuName-style indirection to generate and copy back. Register:

```text
https://<your-loxep-origin>/api/integrations/etsy/callback
```

So an installation reached at `https://loxep.example.com` registers `https://loxep.example.com/api/integrations/etsy/callback`. **Do not guess it** — Loxep's own keyset dialog displays the exact URL for the running installation with a copy button (see [In Loxep](#in-loxep) below). Copy it from there.

For local development only, Etsy allows one HTTP exception: `http://127.0.0.1:<port>/api/integrations/etsy/callback`. No other `http://` host is accepted — every other redirect URI must be `https://`.

### Decide the Commercial Access question (later, not now)

Etsy's Personal App tier is scoped to "your own use, or tools other sellers may use at limited scale." That distinction matters once Loxep observes shops it does not own (a later milestone) — it is not a decision this guide's connection flow needs answered today, since connecting your own shop for observation is uncontroversial under any reading.

## In Loxep

### Store the keyset

Sign in to Loxep as an administrator and go to **Settings → Integrations**. The Etsy card carries the keyset action: **Set up keyset**, or **Rotate keyset** if one is already stored.

The dialog opens with a **Where to get these** section that repeats the portal path above and displays **this installation's real callback URL** with a copy button. If you have not yet registered the redirect URI in the portal, copy the URL from here first and go do that.

Then fill in the form:

- **Keystring** — from the approved app.
- **Shared secret** — from the approved app.

Save. Both values are write-only: stored application-encrypted and never shown again, including by this dialog, which always reopens blank. Saving again replaces the whole keyset. There is one keyset per installation, shared by every Etsy shop you connect.

The Etsy card should now read **Keyset configured**.

### Connect an Etsy shop

Go to **Settings → Connections** and choose **Add Etsy shop** on the Etsy group. The dialog asks for:

- **Shop name** — how this shop is labelled inside Loxep. A local label; it does not have to match the shop's Etsy name.
- **Etsy shop id** — the numeric id Etsy assigns the shop (visible in the shop's own dashboard URL, not the shop's storefront name).
- **Economic entity** — optional business attribution. It records which of your businesses the shop belongs to and grants no access of any kind.
- **Access to request** — see [How much access to ask for](#how-much-access-to-ask-for) below.

Choosing **Continue to Etsy** creates the connection record and then navigates this tab to Etsy's PKCE consent screen. Sign in there as the Etsy account that owns the shop, and accept the requested access. Etsy returns you to Loxep and the shop shows as connected.

If you decline, the connection record stays in place, unconnected, so you can retry it later rather than starting over.

### How much access to ask for

Etsy grants access in *scopes*, and Loxep offers two fixed combinations rather than a checklist:

| Choice | What it covers | When to pick it |
|---|---|---|
| **Shop & listings** | The shop's full listing set, including drafts and inactive listings (`shops_r`, `listings_r`). | The default, and the safe answer for m1 observation. Every keyset can grant it. |
| **Shop + order history** | The above plus read-only access to the shop's receipts and transactions (`transactions_r`). | Reserved for when order ingestion ships — asking for it today grants access Loxep does not yet use. |

Unlike watching *active* listings, which needs no consent at all (Loxep's public-auth reads cover that), consenting a shop is what lets Loxep see the shop's drafts and inactive listings too — that is the entire reason `etsy_shop` monitors benefit from a connected shop rather than only reading the public active-listings feed.

Etsy scope-checks every private-auth call, and — like eBay — does not partially grant a consent: asking for a scope the app was not approved for fails the whole request, not just the extra permission.

### Confirm it works

On the connections page, use the Etsy connection's **Validate** action. It calls `openapi-ping` — the cheapest call this adapter has a shape for, needing only the keyset — and reports the result. Validating also records the outcome on the connection, so it doubles as a manual health check later.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Every call fails, including `openapi-ping` | The app has not been approved yet. There is no "approved but read-only" wait state — check the Developer Portal for the app's status. |
| App registration itself is refused | Two-factor authentication is not enabled on the Etsy account, or the captcha identity-verification step was not completed. |
| Etsy rejects the redirect URI | The registered URI does not match this installation's callback URL exactly, or it is `http://` against a non-`127.0.0.1` host. |
| Consent fails only after a long detour | The nonce and PKCE-verifier cookies backing the flow are short-lived. Start the connection again and complete it in one sitting. |
| Etsy rejects the whole consent with an `invalid_scope`-shaped error | Order access was requested against an app that was not approved for the `transactions_r` scope. Connect with **Shop & listings** instead. |
| A shop's drafts/inactive listings never show up | The shop was never consented (only the public active-listings feed is being read) — connect it via **Add Etsy shop** rather than relying on `etsy_shop`'s public-auth default. |

## Removing a shop

Removing a shop has two outcomes, and the stored data decides which one you get.

- **Delete** is available when nothing in Loxep references the shop. The connection and every credential held against it are removed outright.
- **Archive** is what happens instead once the shop has produced anything — monitors, observations, or provenance records. Nothing is deleted: the shop is retired, disappears from pickers, and is skipped by polling, while everything it produced keeps resolving.

Open the shop's row menu on **Settings → Connections** and choose **Delete**. If anything references it, Loxep refuses, lists exactly what is in the way with counts, and offers **Archive instead**.

One Etsy-specific caveat: neither action withdraws consent at Etsy. Deleting removes Loxep's copy of the token; revoking the app's access on the Etsy account itself is done in Etsy's own account settings.

## Related

- [Connecting eBay](../connecting-ebay/), [Connecting WooCommerce](../connecting-woocommerce/), and [Connecting Medusa](../connecting-medusa/) — the other provider setups.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
- [Etsy Integration Design](../../architecture/etsy-integration-design/) — the binding design this connection flow implements, including the rate-budget and money-conversion decisions behind it.
