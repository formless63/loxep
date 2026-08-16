---
title: Provisioning templates
---

A provisioning template is a strictly ordered list of idempotent steps you build once and run against a fresh set of inputs — "declare `example.com`, point it at this hosting target, front it with a Pangolin resource and a bypass rule, register mail, ensure `noreply@`" as one form instead of six separate actions across three settings pages. The engine that runs it is a **compiler and a driver, never a second workflow engine**: it compiles your template plus your answers into a frozen plan, then advances that plan one step at a time by calling the exact same services a "Sync now" button or an "Enable mail" toggle already calls. See [Pangolin Integration & Chain-Provisioning Templates](../../architecture/pangolin-chain-design/#the-template-engine) for the full design.

## What you will need

- **Administrator access** to the Loxep installation — every write here (creating a template, starting or resuming a run) is admin-only, the same rule that governs every Pangolin/Cloudflare/Purelymail write.
- At least one **DNS connection** (Cloudflare) if your template declares a domain or DNS records.
- A **hosting target** if your template points DNS at one or fronts it with a Pangolin resource.
- A **mail connection** (Purelymail) if your template enables mail.
- A **Pangolin connection**, linked to your hosting target, if your template ensures a proxy resource or rules.

None of these are required to *create* a template — only to *run* one against real inputs.

## The seven step kinds, and nothing else

A template step is one of exactly seven kinds, each mapping to an existing Loxep service:

| Step kind | What it does |
|---|---|
| `domain.declare` | Declares a managed domain (or finds an existing one by name) and resolves its Cloudflare zone. |
| `dns.point-at-target` | Sets the domain's apex/wildcard target and proxied flags, then syncs the records. |
| `dns.manual-record` | Adds one manual DNS record (a TXT verification record, for example), then syncs. |
| `proxy.ensure-resource` | Declares a Pangolin resource fronting a hosting target, and creates it if missing. |
| `proxy.ensure-rules` | Declares one or more access rules on a resource, and creates any that are missing. |
| `mail.enable` | Registers the domain with a mail connection and drives it through ownership verification. |
| `mail.ensure-mailbox` | Declares one mailbox or alias, and creates it once the domain's mail is verified. |

That is the whole vocabulary, closed on purpose. A template that wants an eighth thing is a template that wants a new Loxep service — that is a conversation for a new milestone, not a scripting language bolted onto `params`.

## Creating a template

Go to **Infrastructure → Templates**. If none exist yet, click **Create from example** — this builds the "New domain" template (the six-step shape above) with no live call and no seeded data; it is created on your click, the same way an installation's first mailbox template is created on someone's click rather than shipped in a migration.

A step's parameters can reference an input by name with `${inputKey}` — for example, `domain.declare`'s `name` is `${domain}`, so every run asks you for a domain name and substitutes it in. This is the entire templating language: no conditionals, no loops, no expressions. If your workflow genuinely needs a branch, that is two templates, not one template with an `if`.

## Running a template

Open a template and click **Run template**. The wizard renders one field per `${placeholder}` your template's steps reference — a plain text field for most, and a connection/hosting-target picker for the well-known ones (`dnsConnectionId`, `mailConnectionId`, `hostingTargetId`).

**Preview is mandatory.** Click **Preview compiled plan** before **Start run** becomes available — this is where you see exactly which steps will run, in order, with their fully-resolved parameters, before anything is created. Changing an input after previewing marks the preview stale; preview again before starting.

Clicking **Start run** writes the frozen plan and enqueues the driver — it does not wait for anything. You land on the run's own page, which shows the same step ladder advancing as the driver works through it.

## Reading a run

Each step in the ladder is one of:

- **Succeeded** — done, and (for every step except `domain.declare`) linked to the ordinary reconcile run that is its evidence — the exact same kind of run a manual "sync now" or "apply" click would have produced.
- **Blocked** — a first-class state, never a silent skip and never a failure. The step names the exact remedy: `credential_scope` means a connection's write policy needs raising on **Settings → Connections**; `zone_not_found` means the Cloudflare zone needs creating or confirming in Cloudflare's own dashboard first; `org_domain_not_found` means the Pangolin org domain needs adding there first; `awaiting_delegation` means the registrar hasn't finished pointing nameservers yet. Every one of these clears on its own once the underlying fact changes — clicking **Resume run** re-checks it.
- **Pending** — not yet reachable. A step waits for the specific earlier step it structurally depends on (`proxy.ensure-rules` waits on `proxy.ensure-resource`; every DNS/proxy/mail step waits on `domain.declare`) — an unrelated step elsewhere in the plan can still be attempted on the same pass.
- **Failed** — a real fault (the provider was unreachable, credentials were rejected). **Resume run** retries it.

**Resume is always safe.** It re-enqueues the same run; a step that already succeeded is skipped, a step that made a non-idempotent provider create is protected a second time by the same ledger every reconciler uses, and a step waiting on something outside Loxep's control (DNS delegation, a policy flip) simply re-checks whether it has cleared yet. There is no limit on how long a run may sit partially complete — the design's own words are "run it again in an hour, a day, or a week and it picks up from wherever reality now is."

## Abandoning a run

**Abandon run** marks a run failed and stops there. **It does not undo anything.** Every step this run already completed — a declared domain, a created Pangolin resource, a registered mail domain — stays exactly as it is. There is no rollback anywhere in this engine, because every step it can take is additive or convergent: nothing it does needs undoing, and nothing it *could* undo has a safe way to be undone (Pangolin, for one, has no delete verb Loxep will ever call). If a run is stuck on something you have decided not to fix, abandoning it just stops the ladder from asking again — everything already built keeps working.

## The honest blocked demo

The seeded "New domain" example is deliberately unrunnable to completion on a fresh installation: Cloudflare, Purelymail, and Pangolin connections all default to a `read_only` write policy, so a run built from the example will genuinely block at `dns.point-at-target`, `proxy.ensure-resource`, and `mail.enable` until an administrator raises each connection's policy on **Settings → Connections**. That is not a bug in the example — it is the write-authorization model working exactly as designed, on the very first template anyone runs.

## Related

- [Pangolin Integration & Chain-Provisioning Templates](../../architecture/pangolin-chain-design/#the-template-engine) — the full design, including the write-risk model every provider-touching step passes through.
- [Connecting Cloudflare](../connecting-cloudflare/), [Connecting Purelymail](../connecting-purelymail/), [Connecting Pangolin](../connecting-pangolin/) — the three provider connections a template's steps can touch.
