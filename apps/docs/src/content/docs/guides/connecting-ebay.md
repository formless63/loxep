---
title: Connecting eBay
---

Connecting eBay is the longest of the provider setups because eBay splits it into two things: one **application keyset** that identifies this Loxep installation to eBay, and one **user consent** per eBay account you want Loxep to observe. The keyset is configured once by an administrator; consent is repeated for each account.

Work through the sections in order. Everything in "In the eBay developer portal" happens on eBay's site; everything in "In Loxep" happens on `/settings/integrations` and `/settings/connections`.

## What you will need

- An **eBay developer account** at [developer.ebay.com](https://developer.ebay.com/). It is free and separate from an ordinary eBay buying/selling account, though you sign in with an eBay account to create one.
- **Administrator access** to the Loxep installation.
- The installation's **public address** — the URL people type to reach Loxep. It is the `LOXEP_PUBLIC_ORIGIN` bootstrap value; see [Configuration & Secrets](../../architecture/configuration-and-secrets/). Loxep shows you the exact callback URL derived from it, so you do not have to assemble it by hand.
- A decision about **environment** — sandbox or production — before you copy anything. The next section covers it.

## Sandbox or production

An eBay developer account holds two independent keysets, and the two environments share nothing.

**Sandbox** is eBay's isolated test site. It has its own listings, its own item numbers, and its own logins. No real money moves and no real listing is affected. It is the right choice for a first connection, for trying the flow end to end, and for any work where a mistake should not touch a live account.

**Production** is the live eBay site. Real listings, real accounts, real rate limits, real consequences. It is what you want once the setup is proven.

The choice propagates: sandbox App/Cert/Dev IDs only work against sandbox, a sandbox RuName only resolves in sandbox, and the sandbox consent screen only accepts sandbox test users. Mixing halves from the two environments is the single most common way this setup fails. Loxep stores exactly one keyset, so an installation is in one environment at a time; [Switching to production](#switching-to-production) below covers moving between them.

## In the eBay developer portal

### Create the keyset

Sign in to your developer account and open [Application Keysets](https://developer.ebay.com/my/keys) (the portal calls the page "Application Keys"). You will see a Sandbox block and a Production block. Choose the one you decided on above and note three values from it:

| eBay's label | Also shown as | Goes into Loxep as |
|---|---|---|
| App ID | Client ID | App ID |
| Cert ID | Client Secret | Cert ID |
| Dev ID | — | Dev ID |

Treat Cert ID as a password. It authenticates this installation to eBay.

### Register the redirect URL and get a RuName

eBay does not accept a plain callback URL as the OAuth redirect target. Instead you register the callback URL against the keyset, and eBay issues a **RuName** ("eBay Redirect URL name") that stands in for it. The RuName is what travels in the authorization request; eBay resolves it back to the URL you registered. That indirection is why both values have to be kept in step.

1. On the keyset, choose **User Tokens**.
2. Choose **Add eBay Redirect URL**.
3. Fill in the form:
   - **Display title** — anything recognisable, for example your organisation's name. Buyers and sellers see it on the consent screen.
   - **Your auth accepted URL** — this installation's callback URL. The pattern is the public origin plus Loxep's fixed callback path:

     ```text
     https://<your-loxep-origin>/api/integrations/ebay/callback
     ```

     So an installation reached at `https://loxep.example.com` registers `https://loxep.example.com/api/integrations/ebay/callback`. **Do not guess it** — Loxep's own keyset dialog displays the exact URL for the running installation with a copy button (see [In Loxep](#in-loxep) below). Copy it from there.
   - **Your auth declined URL** — the same callback URL is fine. Loxep handles a declined consent as well as an accepted one and returns the operator to the connections page either way.
   - **Your privacy policy URL** — eBay asks for one; give the address of whatever privacy statement covers your installation.
4. Select **OAuth**. This is a radio choice between OAuth and the older Auth'n'Auth scheme, and Loxep only implements OAuth. Picking Auth'n'Auth produces a RuName that will fail at the consent step with no obvious explanation.
5. Save. eBay generates the **RuName** — a string shaped roughly like `Your_Name-YourApp-SBX-abc123` (the `SBX` fragment marks a sandbox RuName). Copy it.

### Register a sandbox test user

Skip this section if you chose production.

The sandbox consent screen is a separate sign-in from eBay's real one, and **a real eBay account cannot sign in to it**, however valid the account is. Sandbox consent requires a sandbox test user: a virtual account that exists only in the sandbox environment.

In the developer portal, open **User Access Tokens** and choose **Register a new Sandbox user**, then complete the registration form. Two constraints are worth knowing before you start:

- Every sandbox username is prefixed `TESTUSER_`, and that prefix cannot be changed.
- Each test user needs its own unique email address, or the registration is rejected.

Keep the test user's credentials — you will type them into the consent screen. eBay's own walkthrough is [Create a test Sandbox user](https://developer.ebay.com/api-docs/static/gs_create-a-test-sandbox-user.html).

## In Loxep

### Store the keyset

Sign in to Loxep as an administrator and go to **Settings → Integrations**. The eBay card carries the keyset action: **Set up keyset**, or **Rotate keyset** if one is already stored.

The dialog opens with a **Where to get these** section that repeats the portal path above and — the part worth coming back for — displays **this installation's real callback URL** with a copy button. If you have not yet registered the redirect URL in the portal, copy the URL from here first and go do that.

Then fill in the form:

- **Environment** — must match the keyset you copied from. Sandbox credentials never authenticate against production, and the reverse.
- **App ID**, **Cert ID**, **Dev ID** — from the keyset.
- **RuName** — the value eBay generated when you saved the redirect URL. It is optional at the schema level but consent cannot run without it, so an installation missing it shows a "Redirect URL name missing" status and refuses to add accounts.

Save. Every value is write-only: it is stored application-encrypted and no surface, including this dialog, ever shows it again. The dialog always reopens blank, and saving again replaces the whole keyset rather than editing part of it. There is one keyset per installation, shared by every eBay account you connect.

The eBay card should now read **Keyset configured**, with the environment shown beside it.

### Connect an eBay account

Go to **Settings → Connections** and choose **Add eBay account** on the eBay group. The dialog asks for two things and then hands off:

- **Account name** — how this account is labelled inside Loxep. It is a local label; it does not have to match the eBay username.
- **Economic entity** — optional business attribution. It records which of your businesses the account belongs to and grants no access of any kind.

The dialog's **What happens next** section states the environment the installation is in and, in sandbox, repeats the test-user requirement.

Choosing **Continue to eBay** creates the connection record and then navigates this tab to eBay's consent screen. Sign in there as the account you want Loxep to observe — the sandbox test user in sandbox, the real account in production — and accept the requested access. eBay returns you to Loxep and the account shows as connected.

If you decline, the connection record stays in place, unconnected, so you can retry it later rather than starting over.

### Confirm it works

On the connections page, use the eBay connection's **Validate** action. It makes one real authenticated call and reports the result:

- Before consent, it exercises the keyset alone and reports that eBay accepted the application keyset.
- After consent, it reads one page of the connected account's watchlist — the same call Loxep's own polling makes — so a pass means ingestion will work rather than merely that the credentials parse.

Validating also records the outcome on the connection, so it doubles as a manual health check later.

## When it does not work

| Symptom | Usual cause |
|---|---|
| "Redirect URL name missing" on the eBay card | The keyset was saved without a RuName. Rotate the keyset with the RuName included. |
| The consent screen rejects a valid eBay login | The installation is in sandbox and you are using a real account. Register a sandbox test user. |
| eBay reports an invalid or unknown redirect | The RuName does not belong to the keyset that was stored, or OAuth was not selected when the redirect URL was created. |
| Consent returns to an error page or the wrong host | The registered auth accepted URL does not match this installation's real callback URL. Compare it against the URL shown in the keyset dialog. |
| Consent fails only after a long detour | The nonce cookie backing the flow is short-lived. Start the connection again and complete it in one sitting. |
| Everything authenticates but nothing is observed | Consent succeeded on a different eBay account than intended. Check which account you signed in as. |

## Switching to production

Moving an installation from sandbox to production is not a toggle — the production environment needs its own keyset, its own registered redirect URL, and fresh consent from real accounts.

1. In the developer portal, work through [Create the keyset](#in-the-ebay-developer-portal) and [Register the redirect URL](#in-the-ebay-developer-portal) again against the **Production** keyset. The callback URL you register is the same one; the RuName is new.
2. In Loxep, open the eBay card and choose **Rotate keyset**. Set Environment to **Production** and enter the production App ID, Cert ID, Dev ID, and RuName. This replaces the sandbox keyset outright.
3. Reconnect each eBay account. Tokens issued in sandbox are meaningless in production, so existing sandbox connections will no longer validate. Add the production accounts as new connections and remove the sandbox ones once you no longer need them.
4. Validate each new connection before relying on it.

Two things change in character at this point. Production rate limits are real, so polling budgets matter. And consent is now granted by a real eBay account, which can withdraw it from eBay's own account settings at any time — a connection that stops validating for no local reason is worth checking there first.

## Related

- [Connecting WooCommerce](../connecting-woocommerce/) and [Connecting Medusa](../connecting-medusa/) — the other provider setups.
- [Configuration & Secrets](../../architecture/configuration-and-secrets/) — why provider credentials live in the database rather than in environment variables.
- [System Overview](../../architecture/system-overview/) — where provider ingestion sits in the runtime.
