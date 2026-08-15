---
title: Connecting Pangolin
---

[Pangolin](https://docs.pangolin.net) is a self-hosted reverse-proxy and tunnel identity provider — the access layer in front of a self-hosted estate, including (in a typical installation) Loxep itself. **This connection is milestone 1 of a longer design: read-only, with no exceptions.** `@loxep/integration-pangolin` has no write verb of any kind today — not a configuration flag, not an admin toggle. It reads orgs, sites, resources, targets, access rules, and org domains, and nothing it does can change what Pangolin protects.

:::caution[This is not the URL you sign in to]
Pangolin runs its **Integration API** as a completely separate server from the dashboard — its own port (conventionally `3003`), under the path prefix `/v1`, gated by the instance's own `flags.enable_integration_api` setting. A self-hosted operator must add a dedicated reverse-proxy route for this API before anything outside the Pangolin container can reach it — Pangolin's own documentation recommends a dedicated subdomain, e.g. `https://api.your-domain.com`. **Pasting the Pangolin dashboard's own URL into this connection will save successfully and then fail on first use.** This is the single most common first-attempt failure for this integration, and it is exactly what a milestone-1 live reconnaissance run against a real instance confirmed.
:::

## What you will need

- **Admin access** to the Pangolin dashboard, so you can view an organization's API keys.
- **Administrator access** to the Loxep installation.
- **A working reverse-proxy route for the Integration API**, reachable from the machine Loxep runs on (not just from your browser). Verify it before touching Loxep: `<that URL>/v1/openapi.json` must answer JSON, not an HTML page — a wrong URL still answers *something*, usually the dashboard's own app shell, which looks plausible until the first real read fails.
- **The organization's id** — the slug visible in the dashboard URL when that organization is open.

## Create an API key in Pangolin

1. Sign in to the Pangolin dashboard and open the organization you want Loxep to read.
2. Go to **API Keys** and create a new key.
3. Choose **Organization** scope, not **Root**. An organization-scoped key can only ever read the one org it was issued for — narrower is safer, and this milestone never needs more than one org per connection. A root key (self-hosted only, cross-org) works too if you would rather Loxep discover every org on the instance, but it is a broader credential than this milestone needs.
4. Grant read actions only: `listOrgs`, `listSites`, `getSite`, `listResources`, `getResource`, `listTargets`, `listResourceRules`, `listOrgDomains`, and their single-item equivalents. Nothing here needs a create/update/delete action, ever — granting one today buys nothing and just widens the credential ahead of a future milestone that will ask for it deliberately, with its own re-consent.
5. Pangolin shows the key **once**, as two parts: a key id and a key secret. Copy both before leaving the page.

:::note[The scope you grant doesn't change what Loxep can do]
This milestone's adapter has no member that could issue a write, regardless of what the key is scoped to. A broader key is a future-widening risk, not a present one — but it is still worth granting only reads, because the next milestone that adds a write verb will need its own owner ruling before it can use a broader scope productively.
:::

## In Loxep

Sign in as an administrator, go to **Settings → Connections**, and choose **Add Pangolin instance**.

Fill in:

- **Instance name** — how the instance is labelled inside Loxep.
- **Integration API URL** — the Integration API's own origin from the callout above. Not the dashboard URL.
- **Organization id** — the org slug from the dashboard URL.
- **API key id** and **API key secret** — the two halves Pangolin showed you. Loxep sends them together as `Authorization: Bearer <id>.<secret>`, but stores them as two separate encrypted fields.
- **Economic entity** — optional business attribution. It records which of your businesses the instance belongs to and grants no access of any kind.

Save. The instance URL and organization id are kept as ordinary connection configuration and stay visible; the key secret is stored application-encrypted and is never displayed again.

## What milestone 1 reads

Orgs, sites, resources, targets, access rules, and org domains — the whole read surface the design document defines for this milestone, and nothing more. Milestone 1 does not yet wire a scheduled poll or a fleet-page panel; the adapter exists and is connectable, and the next milestones (`loxep-acj.2` and later) build the reconciler that turns these reads into a rendered chain (domain → DNS record → Pangolin resource → hosting target) and, eventually and only after an explicit owner ruling, the write path.

**Loxep never manages the Pangolin dashboard's own resource, and never manages the resource that fronts Loxep itself.** That rule is designed in from the start (see the design document's write-risk model) even though milestone 1 cannot write at all — it is the shape every later milestone inherits.

## Read-only, and why that matters more here than for any other provider

Every other integration Loxep connects to has a bad day when something goes wrong: a wrong DNS record breaks a name, a wrong mailbox costs money. Pangolin is different — it is the identity proxy in front of the estate, so a bad write here can remove your own way back in, including into Loxep itself if Pangolin fronts it. That is why this milestone ships read-only with no exception, and why the write milestones that follow require an explicit owner decision before any of them ship (see [the design document's write-risk model](../../architecture/pangolin-chain-design/#the-write-risk-model)).

## When it does not work

| Symptom | Usual cause |
|---|---|
| Every read fails with an HTML-looking error, or an unauthorized/not-found response that doesn't match anything you set up | The Integration API URL is wrong — most often, it is the dashboard URL. Verify `<url>/v1/openapi.json` answers JSON from the Loxep host directly, per the callout above. |
| "Unauthorized" immediately | The key id/secret pair is wrong, or the key was scoped to a different organization than the one you entered. |
| Connects, but returns nothing | The organization id doesn't match any organization the key can see — double check the slug in the dashboard URL, not the organization's display name. |
| Works, then stops after a Pangolin update | Pangolin's own documentation is explicit that the Integration API "may include breaking changes between updates." Loxep reads every field defensively; report what changed so the adapter can be corrected. |

## Related

- [Pangolin Integration & Chain-Provisioning Templates](../../architecture/pangolin-chain-design/) — the full design this connection is milestone 1 of, including the write-risk model that gates every milestone after this one.
- [Connecting Cloudflare](../connecting-cloudflare/) and [Connecting Purelymail](../connecting-purelymail/) — the other two control-plane providers in the same chain.
