---
title: Notifications Design
---

How Loxep decides that something is worth telling a human about, and how that
fact reaches a transport. Written for `loxep-oii` (weave audit 2026-08 finding
5) and binding from migration `0022` onward. The ruling itself is
[ADR-0023](../../decisions/0023-notifiable-events-and-delivery-subjects/); this
document is the mechanism.

The implementation contract's rule is the frame: **event detection and
notification delivery remain separate concepts, and ntfy is the first
transport, not the model.** Before this design, half of that was true — the
transport interface was genuinely neutral while the ledger and the rule
matcher were market-shaped, because `notification_deliveries.market_event_id`
was `NOT NULL` against `market_events`. Detection existed for purchases,
documents, manual sales, DNS drift, and integration health; none of it could
be delivered.

## The three layers

```text
detection                       routing                    delivery
---------                       -------                    --------
domain services write     ->    notification_rules    ->   notification_deliveries
notification_events             (class x type x            + notifications.deliver
(@loxep/domain)                  monitor target)            + NotificationTransport
                                (@loxep/notifications)      (@loxep/notifications)
```

Each arrow is an explicit call, never an implicit consequence. Deriving a
market event does not enqueue a notification; upserting a health row does not
enqueue a notification; recording a notification event does not send anything.
The bridge is `publishNotificationEvent` (record, then route, then enqueue),
and every caller passes in its own enqueue seam.

### Why the ledger is in `@loxep/domain` and routing is not

`@loxep/inventory`, `@loxep/commerce`, and `@loxep/documents` cannot import
`@loxep/notifications` — it depends on `@loxep/domain`, and the reverse edge
would be a cycle. All of them already depend on `@loxep/domain`. So the
notifiable-event ledger, the event-class registry, and the routing predicate
live in `@loxep/domain` (`notification-events.ts`), and endpoints, rules CRUD,
transports, renderers, and the `notifications.deliver` task stay in
`@loxep/notifications`.

This is the same call that put `integration_health` in `@loxep/domain` rather
than in the phase that introduced it: a shared foundation table written by
many domains belongs with connections, settings, and secrets.

## `notification_events`

```text
id                    uuid primary key
event_class           text not null      -- closed CHECK, the rule dimension
event_type            text not null      -- open within a class (registry-validated)
subject_type          text not null      -- closed CHECK; which table subject_id is in
subject_id            uuid not null      -- deliberately NOT a foreign key
monitor_target_id     uuid null references monitor_targets(id)
occurred_at           timestamptz not null
payload               jsonb not null default '{}'
deduplication_key     text not null unique
created_at            timestamptz not null default now()

index (occurred_at desc)                       -- the feed
index (event_class, occurred_at desc)          -- the per-class feed
index (subject_type, subject_id, occurred_at desc)  -- "what happened to this thing"
```

- **`subject_id` is not a foreign key.** It is polymorphic across a dozen
  tables — the trade `integration_health.subject_id`, `reconcile_runs.subject_id`,
  and `journal_entry_source_links` already make. A notification about a thing
  that was later deleted is still a true record of what Loxep told you.
- **`deduplication_key` is `UNIQUE` and every emitter must supply one.**
  Emission is `ON CONFLICT DO NOTHING`; a re-run of an at-least-once handler
  records nothing and routes nothing, so it cannot notify twice. Conventions:
  `market_event:<market event id>` (reusing the market event's own dedupe
  discipline), `acquisition:<id>:purchase_ingested`,
  `document:<id>:confirmed:<confirmed_at ISO>`,
  `order:<id>:manual_sale_recorded`,
  `health:<subject_type>:<subject_id>:<event_type>:<status_changed_at ISO>`.
- **`payload` is the render input**, small, Loxep-owned, and redacted by
  construction — the emitter chooses the handful of facts a message needs.
  Never a provider response, a header, or credential material; the same
  discipline `guardHealthDetail` enforces for `integration_health.detail`.
- **`monitor_target_id` is the one narrowing dimension rules can filter on.**
  It is null for every non-market class today, which is why a health event
  matches only monitor-agnostic rules — the shipped matcher semantics,
  unchanged.
- **No retention policy**, consistent with `market_events` and the
  observation schema. One row per *detected change*, not per observation.

### Closed sets, seeded ahead

`event_class` (`CHECK`): `market`, `purchase`, `document`, `sale`, `health`,
`infrastructure`. The first five are wired; `infrastructure` is seeded for DNS
drift and reconciler failures so that phase needs no migration.

`subject_type` (`CHECK`): `market_event`, `acquisition`, `document`, `order`,
`connection`, `notification_endpoint`, `storage_backend`, `external_resource`,
`hosting_target`, `managed_domain`, `monitor_target`, `reconcile_run`. Seeded
the same way, and deliberately a superset of `HEALTH_SUBJECT_TYPES` so a
health transition's subject type is always representable.

`event_type` is **not** `CHECK`ed. The valid `(class, type)` pairs live in the
`@loxep/domain` event-class registry — the closed-union-plus-config shape
monitor-target registration already uses — so adding a type to a shipped class
is a registry entry, not a migration, while the coarse dimensions a rule filters
on stay database-enforced.

## The event-class registry

```ts
notificationEventClasses = {
  market:   { subjectType: 'market_event', eventTypes: MARKET_EVENT_TYPES, ... },
  purchase: { subjectType: 'acquisition',  eventTypes: ['purchase_ingested'], ... },
  document: { subjectType: 'document',     eventTypes: ['document_confirmed'], ... },
  sale:     { subjectType: 'order',        eventTypes: ['manual_sale_recorded'], ... },
  health:   { subjectTypes: NOTIFIABLE_HEALTH_SUBJECT_TYPES,
              eventTypes: ['health_degraded', 'health_recovered'], ... },
}
```

Each definition carries its label, its permitted subject type(s), its event
types, and a default transport priority. `recordNotificationEvent` validates
`(class, type, subject_type)` against it before writing, so an unroutable
event — a rule that could never match, a subject in the wrong table — fails at
the emission site instead of becoming a silent no-op in the matcher. The
registry is also what `/settings/notifications` renders its class/type pickers
from, so the UI cannot offer a combination the writer would reject.

## Rules: the two-column extension

```text
notification_rules
  event_class        text not null      -- NEW; existing rows stamped 'market'
  event_type         text null          -- RENAMED from market_event_type; null = any in class
  monitor_target_id  uuid null          -- unchanged; null = any
  endpoint_id        uuid not null
  conditions         jsonb              -- still unused, still not a rules engine
```

Matching, unchanged in spirit:

```sql
enabled
and event_class = :eventClass
and (event_type is null or event_type = :eventType)
and (:monitorTargetId is null
       ? monitor_target_id is null
       : (monitor_target_id is null or monitor_target_id = :monitorTargetId))
```

`event_class` is `NOT NULL` on purpose — there is no "any class" wildcard.
Stamping every shipped rule `'market'` means no existing rule silently widens
to cover health transitions or purchases the moment this migration lands, which
a nullable wildcard would have done.

**What this deliberately is not:** thresholds, quiet hours, per-class
predicates, rate limits, escalation, or a generalized `(subject_type,
subject_id)` narrowing. The audit's own not-worth-wiring list names those;
`conditions` stays an unused column rather than becoming the seam that grows
one.

## Delivery

`notification_deliveries` keeps every property it shipped with — one `NOT NULL`
foreign key to its subject, a `UNIQUE (subject, endpoint)` pair, attempt
accounting, and a delivered-row no-op guard — with `market_event_id` replaced
by `notification_event_id`:

```text
notification_event_id  uuid not null references notification_events(id)
endpoint_id            uuid not null references notification_endpoints(id)
unique (notification_event_id, endpoint_id)
```

The `notifications.deliver` payload becomes `{ notificationEventId, endpointId }`
and the job key `notifications.deliver:<notification_event_id>:<endpoint_id>`.
At-least-once safety is byte-for-byte the argument it was before, with a
different subject.

### Rendering

Renderers are pure functions over the recorded row — `(event_class,
event_type, payload)` in, `NotificationMessage` out — so a renderer
improvement improves the rendering of events recorded before it. `render.ts`
holds both:

- `renderMarketEventMessage` (market class) — per-type price/quantity/state
  deltas, the canonical listing URL, and now a `new_listing` case (title,
  price, discovering monitor, listing URL) and an opportunity block: when a
  market event carries the `payload.opportunity` stamp written by
  `@loxep/market`'s rule evaluator, the attributing rule's **name and score**
  reach the message title and body instead of being invisible.
- `renderNotificationEventMessage` (every other class) — purchase, document,
  sale, and health messages, each with the class's default priority.

The delivery job dispatches on `event_class`: `market` goes through the
injected `renderMessage` option (so `@loxep/app`'s listing-context
enrichment keeps working unchanged), everything else through the class
renderer.

### Two enqueue paths, on purpose

- **Market**: the poll executors already hold a typed `AddJob`;
  `enqueueDeliveriesForEvent(addJob, marketEvent)` keeps its exact shipped
  signature, records the `market`-class event, and enqueues through it.
- **Domain services**: a `NotificationEnqueue` seam issuing
  `graphile_worker.add_job` **through the caller's executor**, so an emission
  inside a transaction is part of that transaction and a rollback takes the
  job with it. `@loxep/jobs`' own `addJob` takes a pool and opens its own
  connection, which is precisely the shape that silently loses atomicity —
  the same reasoning, and the same seam shape, as
  `@loxep/infrastructure`'s `createTransactionalEnqueue`. Tests wire
  `createRecordingNotificationEnqueue`.

Routing is short-circuited before the seam is touched: with no matching
enabled rule there is no enqueue call at all, so a service running against a
database with no worker schema (a scratch test database) records its event and
does nothing else.

## Detection wiring, class by class

| Class | Where it is emitted | Transactional with the write |
| --- | --- | --- |
| `market` | the shipped bridge in `@loxep/app`'s poll executors, unchanged | no (unchanged; a notification failure never rolls back an observation) |
| `health` | `runHealthSweep`'s per-subject loop (`@loxep/domain`) | no — `upsertHealth` is one autocommit upsert |
| `purchase` | `ingestEbayPurchase` after a `created` draft acquisition (`@loxep/inventory`) | no — purchase sync has no transaction by design |
| `sale` | `recordManualSale` inside its transaction (`@loxep/commerce`), and the `apps/web` re-declaration that is the live path today | yes (package); yes, via savepoint (web) |
| `document` | `confirmLinesAsExpense` after the counter recompute flips a document to `confirmed` (`apps/web`) | yes, via savepoint |

Emission inside a caller's transaction goes through a **savepoint**
(`tx.transaction(...)`) with its own try/catch, because PostgreSQL aborts the
whole transaction on any statement error: without the savepoint, a notification
problem would roll back the domain write it was reporting on. Outside a
transaction the call is simply wrapped in try/catch and logged — the same rule
the market bridge has always followed.

### Health transitions: what is notifiable, and what is never

`integration_health` has recorded transitions since migration `0020`
(`previous_status`/`status_changed_at`). `runHealthSweep` already reads each
subject's existing row to compute due-ness, so it knows the prior status at the
moment it writes the new one — no extra read, no change to `upsertHealth`.

Two event types, deliberately narrow:

- `health_degraded` — a transition **into** `degraded` or `failing`;
- `health_recovered` — a transition from `degraded`/`failing` **into** `ok`.

Transitions into or out of `unknown` are recorded in the health row and never
emitted: "we could not tell" is not an alert, and a flapping unknown would be
the loudest thing in the feed.

**Only Loxep's own integration subjects are notifiable**: `connection`,
`notification_endpoint`, `storage_backend`. The fleet subjects —
`external_resource`, `hosting_target`, `managed_domain` — are excluded by the
registry, which is the structural form of the [fleet design's open question 1
ruling](../fleet-observability-design/): Beszel and Gatus alert their own
operators through ntfy already, and Loxep inserting itself as a relay adds a
hop, a failure mode, and a dependency on the machine being reported on. The
fleet design's standing assertion that *no fleet probe writes a
`notification_deliveries` row* survives this design unchanged, and now survives
it by construction rather than by omission.

The Gatus heartbeat endpoint named by `gatusPushSetting.endpointKey` is not an
`integration_health` subject at all (fleet design, Binding Rule 1 — the
self-latching loop), so it cannot become a notification event through any path
described here. The feedback-latch quarantine is preserved for free.

## Surfaces

- `/settings/notifications` — endpoints, rules (now class + type + monitor
  target), and recent deliveries, which read their class/type from the event
  ledger instead of joining `market_events`.
- **The product-shell bell** — reinstated against the real feed. It reads
  recent `notification_events`, rendered by the same pure renderer that
  produces the outbound message, with each entry deep-linked by
  `(subject_type, subject_id)`. Unread state is a client-side
  "last opened" mark, not a server-side per-user read table: the ledger is a
  feed of facts, not a per-user inbox, and Loxep has installation-wide roles
  rather than per-user notification preferences. `loxep-67w` hid the donor
  bell rather than deleting it and required that re-enabling it replace the
  data source rather than restore `mockNotifications` — which is what this
  does; the donor `NotificationCenter` and its mock store stay exactly where
  they are, inside `/starter`.

## Open questions

1. **Retention.** The ledger grows with detected changes and has no policy,
   matching `market_events`. If the market feed dominates the bell in practice,
   the answer is more likely a per-class feed filter than a delete policy.
2. **Per-user read state.** Deliberately not modeled (see above). If several
   operators share an installation and ask for it, it is a small table, not a
   redesign.
3. **The `apps/web` re-declarations.** `recordManualSale` and the document
   counter recompute exist twice (acknowledged in-code). Both copies emit, so
   the feed is correct either way; collapsing them is tracked with the
   dependency-edge work that motivates it, not here.
4. **Purchase and document emission are not transactional with their writes**
   in the package copies — purchase sync has no transaction at all by design.
   A duplicate-suppressed dedupe key makes a lost emission recoverable by a
   re-run, which is the property that matters most for an at-least-once
   pipeline.
