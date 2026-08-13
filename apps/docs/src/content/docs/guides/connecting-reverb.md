---
title: Connecting Reverb
---

A Reverb account connects with a **Personal Access Token** minted in your own Reverb account settings. There is no consent screen, no installation-wide application keyset, and no approval queue — of every marketplace Loxep supports, this is the simplest to set up: the token is self-service and works the moment it is created.

## What you will need

- **Access to the Reverb account** whose listings Loxep should observe.
- **Administrator access** to the Loxep installation.

That is the whole list. There is no base URL to collect (Reverb is one fixed hosted API) and no shop id to enter — the token identifies the account, and Loxep always observes the token owner's own listings.

## In your Reverb account

1. Sign in to the Reverb account.
2. Open **Settings → API tokens** (Reverb's account settings may label this area slightly differently — look for an API or developer-access section).
3. Create a new Personal Access Token.
4. Grant at least the **`public`** and **`read_listings`** scopes. Skip every `write_*` scope — Loxep only ever reads. Add `read_orders` ahead of time only if you plan to enable order sync once it ships; there is nothing for Loxep to do with it today.
5. Copy the token before leaving the page. Reverb, like most personal-token systems, shows it once and will not display it again.

Reverb Personal Access Tokens **do not expire**, so there is no periodic re-authorization step the way eBay's or Etsy's OAuth consent needs.

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Reverb account**. The dialog carries a **Where to get these** section repeating the path above.

Fill in:

- **Account name** — how this account is labelled inside Loxep. A local label; it does not have to match anything in Reverb.
- **Personal Access Token** — the token you just created.
- **Economic entity** — optional business attribution. It records which of your businesses the account belongs to and grants no access of any kind.

Save. The token is write-only: stored application-encrypted and never shown again, including by this dialog, which always reopens blank.

The Reverb card should now read **Connected**.

## Confirm it works

On the connections page, use the Reverb connection's **Validate** action. It calls `GET /my/account` — the cheapest authenticated call this adapter has a shape for — and reports the result. Validating also records the outcome on the connection, so it doubles as a manual health check later.

## When it does not work

| Symptom | Usual cause |
|---|---|
| Validation fails with an authentication error | The token was revoked in Reverb's account settings, or it was pasted with extra whitespace. Mint a new one. |
| A listing target fails but the connection validates fine | The listing id is wrong, or the listing was deleted. |
| The connected account's listings never show up under a `reverb_shop` monitor | The token was minted without the `read_listings` scope. Reverb does not support partially retrying a scope-short request — mint a new token with the right scopes and update the connection's credential. |

## Removing an account

Removing an account connection has two outcomes, and the stored data decides which one you get.

- **Delete** is available when nothing in Loxep references the account. The connection and the encrypted token are removed outright.
- **Archive** is what happens instead once the account has produced anything — monitors, observations, or provenance records. Nothing is deleted: the account is retired, disappears from pickers, and is skipped by polling, while everything it produced keeps resolving.

Open the account's row menu on **Settings → Connections** and choose **Delete**. If anything references it, Loxep refuses, lists exactly what is in the way with counts, and offers **Archive instead**.

One Reverb-specific note: neither action revokes the token at Reverb. Deleting removes Loxep's copy; revoking the Personal Access Token itself is a separate step in Reverb's own account settings.

## Related

- [Connecting eBay](../connecting-ebay/) and [Connecting Etsy](../connecting-etsy/) — the other marketplace setups.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
- [Reverb Integration Design](../../architecture/reverb-integration-design/) — the binding design this connection flow implements, including the verified API facts and the rate-budget decision behind it.
