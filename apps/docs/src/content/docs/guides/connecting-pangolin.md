---
title: Connecting Pangolin
---

[Pangolin](https://docs.pangolin.net) is a self-hosted reverse-proxy and tunnel identity provider — the access layer in front of a self-hosted estate, including (in a typical installation) Loxep itself. This connection reads orgs, sites, resources, targets, access rules, and org domains from milestone 1 on. From milestone 4 (`loxep-acj.4`) it can also **create** a Pangolin resource, add a target, or add an access rule — three additive, non-idempotent writes, ledgered so a crash never double-creates one. Nothing in this connection can ever delete or disable anything at Pangolin: there is no delete verb anywhere in `@loxep/integration-pangolin`, permanently, and retirement (a future milestone) means disabling a rule, never removing it.

**Every write stays refused until an admin explicitly allows it, per connection.** A fresh connection — and every connection created before milestone 4 — starts `read_only`: Loxep can read this instance but cannot create anything at it, structurally, regardless of what the API key itself is scoped to. See [Writes](#writes-milestone-4) below before granting write actions to the key.

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
4. Grant read actions: `listOrgs`, `listSites`, `getSite`, `listResources`, `getResource`, `listTargets`, `listResourceRules`, `listOrgDomains`, and their single-item equivalents. If you intend to ever click **Apply** on a proxy resource in Loxep (see [Writes](#writes-milestone-4) below), additionally grant `createResource`, `createTarget`, and `createResourceRule` — never `deleteResource`, `deleteTarget`, `deleteResourceRule`, `updateResource`, `updateTarget`, or any action naming a site, user, role, org, identity provider, or API key. Loxep never calls those, on this key or any other, so granting them widens the credential for nothing.
5. Pangolin shows the key **once**, as two parts: a key id and a key secret. Copy both before leaving the page.

:::note[Granting the write actions does not, by itself, let Loxep write]
The key's scope and Loxep's own per-connection write policy are two independent gates — Pangolin's granular action list is real scope-limiting Loxep cannot enforce on its own (Purelymail's admin token has no such scoping at all, which is why that connection's safety has to come from policy alone), but Loxep's own policy still defaults every connection to `read_only` regardless of what the key can do. Both must agree before Apply does anything but block. See [Writes](#writes-milestone-4).
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

## What Loxep reads

Orgs, sites, resources, targets, access rules, and org domains — the whole read surface the design document defines. `/infrastructure/domains/$name` renders the chain (domain → DNS record → Pangolin resource → hosting target); `/infrastructure/fleet/$name` renders the same chain grouped by hosting target instead. Both pages also show "Pangolin knows about N resources Loxep does not" whenever the instance holds a resource nothing in Loxep declared — information, never something Loxep will touch.

**Loxep never manages the Pangolin dashboard's own resource, and never manages the resource that fronts Loxep itself.** That rule is designed in from the start (see the design document's write-risk model) and holds however permissive this connection's write policy is set — it is not a setting an admin can turn off.

## Why writes here are different from every other provider

Every other integration Loxep connects to has a bad day when something goes wrong: a wrong DNS record breaks a name, a wrong mailbox costs money. Pangolin is different — it is the identity proxy in front of the estate, so a bad write here can remove your own way back in, including into Loxep itself if Pangolin fronts it. That is why Loxep's writes here go through TWO independent gates rather than one: an admin flip per connection (below), and a pure, unconditional self-lockout check that no flip can bypass (see [the design document's write-risk model](../../architecture/pangolin-chain-design/#the-write-risk-model) for the full six binding rules).

## Writes (milestone 4)

Every connection is **read-only by default** — a fresh install, and every connection created before this milestone, cannot create anything at Pangolin no matter what the API key is scoped to. An admin turns this on **per connection**, on `/settings/connections`, by raising that connection's write-authorization tier from `read_only` to at least `additive`. Flipping it is audited (an `audit_events` row, in the same transaction as the flip) and admin-only, matching the rest of Loxep's admin-only write model.

Once a connection is `additive` or higher, an admin can click **Apply** on a domain's proxy-resources panel (`/infrastructure/domains/$name`). This is a **typed confirmation** — the primary action stays disabled until you type the domain's name — and it applies every resource, target, and rule that domain declares but Pangolin does not have yet:

- a new Pangolin resource, if the domain declares one Pangolin doesn't have (`PUT /org/{orgId}/resource`);
- a new target on an existing resource, once a later milestone adds a way to declare one;
- a new access rule on an existing resource (`PUT /resource/{resourceId}/rule`) — the owner's own named use case, for example a `PATH`-matched bypass rule that lets Loxep reach a companion tool's API through Pangolin without solving SSO for it.

**Every one of these is additive.** Apply never disables, updates, or removes anything that already exists — there is no verb in `@loxep/integration-pangolin` that could, and the closed operation union `@loxep/infrastructure` plans against has no member for one either. If the domain's declared state would also require changing something that already exists (moving a target, changing a rule's value), that operation is recorded as **skipped, not applied** — this milestone does not implement it yet, regardless of how permissive the connection's policy is.

A write policy below `additive` does not make Apply fail — it makes the run come back **`partial`**, with a step explicitly marked `blocked` naming the exact flip that would unblock it, never a silent no-op and never treated as a failure. The self-lockout check runs independently of the policy tier and refuses on its own if the resource in question turns out to front Loxep itself or the Pangolin dashboard's own resource.

**Every create is non-idempotent, and Pangolin has no upsert anywhere in this API.** Loxep never blindly retries a create it isn't sure went through; it re-reads Pangolin and matches on the object's own identity (its full domain, its `(siteId, ip, port)`, its `(action, match, value, priority)`) before deciding whether the object exists.

:::caution[The first real write should target something you can afford to be wrong about]
The design's own rule: point Loxep's very first apply on a live instance at a throwaway resource on a throwaway subdomain, created for the purpose, with you watching — never a resource you actually need.
:::

## Dynamic-IP named aliases (milestone 5)

Pangolin has no alias or IP-group primitive — a rule's `value` is always a plain literal, and there is no bulk-rule endpoint on a self-hosted build. So if a home connection's address changes, every bypass rule that referenced it goes stale silently, one rule at a time. Loxep's answer is its own named alias, managed entirely on the Loxep side: create one under **Infrastructure → IP aliases** (for example, `home`), then reference it from a rule instead of typing a literal address. The rule's stored value becomes `alias:home` — a reference, resolved to today's address only at the moment Loxep builds a request to send to Pangolin.

**Where the address comes from.** Three sources, in the order Loxep trusts them:

- **Manual** — you type the address. No detector runs; you update it yourself when it changes. Always available.
- **DNS** — Loxep resolves a hostname you already maintain (a dynamic-DNS name, which a dynamic address usually already has) once every detection cycle. No third party learns your address; the only new dependency is a DNS lookup you already trust for that hostname.
- **Pangolin site** — Loxep reads the address Pangolin itself has observed for one of your newt sites. Best when it works, because it is the exact address Pangolin will match rules against — but this field is unverified against a live Pangolin release, so treat it as a bonus, not a guarantee, and fall back to DNS or manual if it never changes.

Loxep deliberately never calls a third-party "what is my IP" service — that would be a new outbound dependency and a new trust boundary on a value that becomes a firewall rule, for a convenience DNS or manual already cover.

**Add-then-retire, never replace.** When a detector (or you, editing the alias by hand) observes a new address, Loxep **adds** a new rule for the new address on every resource that references the alias; it never rewrites the old rule in place. The worst case of a wrong detection is a harmless extra ACCEPT rule for an address you no longer hold — never a lost way in. Retiring the old rule (disabling it, never deleting it) is a separate, later, typed-confirmation action milestone 7 adds; until then the old rule simply stays, doing no harm.

**Auto-apply ships off, per alias.** An alias's **Auto-apply** toggle, when turned on, lets a detected change apply the ADD half automatically the next time the detection sweep runs (roughly every 15 minutes) — never the retire half, and only when the connection's own write-authorization tier is `additive` or higher (the same gate every other write here goes through). Turning auto-apply on is never itself sufficient: it only ever permits a *scoped*, reversible-by-construction class of write, and every apply — automatic or manual — still fires the same notification, so an unattended change to an access rule is never one nobody hears about. Auto-apply is unavailable for a `manual`-sourced alias: there is no detector run to trust.

**Every alias change notifies once**, not once per sweep and not once per affected rule — "7 rules across 4 resources reference an address that changed", with a one-click apply for any resource that did not qualify for auto-apply.

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
