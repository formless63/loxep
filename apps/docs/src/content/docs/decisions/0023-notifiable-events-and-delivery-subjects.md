---
title: "ADR-0023: Notifiable Events and Delivery Subjects"
---

**Status:** Accepted 2026-08-15 (`loxep-oii`, weave audit 2026-08 finding 5). Refines the implementation contract's *"event detection and notification delivery remain separate concepts"* rule by giving the delivery ledger a subject that is not a market event. Does not supersede any earlier ADR; resolves [Fleet Observability Design](../../architecture/fleet-observability-design/) open question 1's standing objection that `notification_deliveries` "is not domain-neutral today" and the same document's inconsistency note ("the notification foundation is described as transport-neutral and is only half so").

Shipped in `0022_notification_events.sql`, `@loxep/domain`'s `notification-events.ts`, `@loxep/notifications`' generalized rule matcher and delivery pipeline, and the `/settings/notifications` + product-shell surfaces. The full design is [Notifications Design](../../architecture/notifications-design/).

## Context

`notification_deliveries.market_event_id` was `NOT NULL` with a foreign key to `market_events`, and `market_events.marketplace_item_id` is itself `NOT NULL` against `marketplace_items`. The delivery row's identity — the `UNIQUE (market_event_id, endpoint_id)` pair that makes at-least-once delivery safe — was therefore a market fact. A delivery row for anything else could not exist.

Every event class shipped since Phase 2 is detected and un-notifiable: purchase ingested (draft acquisition), document awaiting/reaching confirmation, manual sale recorded, DNS drift found/disappeared, integration health degraded (observable since migration `0020`, still not notifiable), mail reconciler failure, monitor backoff, connection/token errors.

The transport layer was never the problem: `NotificationMessage` is `{ title, body, priority?, tags?, url? }` and knows nothing about markets. The **ledger** and the **rule matcher** were market-shaped.

Three model candidates were on the table (named in the audit and in the bead):

1. polymorphic subject columns on `notification_deliveries` (`subject_type`, `subject_id`) with the market FK relaxed to nullable;
2. one unified notifiable-events table that `market_events` feeds into;
3. per-class delivery tables.

## Decision

**Adopt candidate 2: a single `notification_events` ledger of notifiable facts. `notification_deliveries` keeps its shape — a `NOT NULL` foreign key to exactly one subject table and a `UNIQUE (subject, endpoint)` pair — with `market_event_id` replaced by `notification_event_id`.**

1. **`notification_events` is the detection-side ledger.** One row per notifiable fact: `event_class` + `event_type` (what happened), `subject_type` + `subject_id` (what it happened to), `occurred_at`, a small Loxep-owned `payload`, and a `deduplication_key` with a `UNIQUE` constraint. `subject_id` is deliberately **not** a foreign key — it is polymorphic across a dozen tables, the same trade `integration_health.subject_id`, `reconcile_runs.subject_id`, and `journal_entry_source_links` already make. `event_class` and `subject_type` are closed `CHECK`ed sets, seeded with the classes and subjects later phases will need so a later migration never has to widen them.
2. **`market_events` feeds it; it does not replace `market_events`.** Market detection is unchanged. The explicit detection→delivery bridge (`enqueueDeliveriesForEvent`, called by the poll executors) now records a `market`-class `notification_events` row for the detected event and enqueues deliveries against that row. Rendering and dedupe are unaffected because the market event's own deduplication key is reused as the notification event's.
3. **The payload is the render input, not stamped text.** The emitter writes the small set of Loxep-owned facts a message needs; renderers stay pure functions over `(event_class, event_type, payload)`, so improving a renderer improves the rendering of already-recorded events. No provider payloads, headers, or credential material — the same discipline as `integration_health.detail`.
4. **Rules gain the class dimension, and nothing else.** `notification_rules.market_event_type` is renamed `event_type` and a `NOT NULL` `event_class` is added; existing rows are stamped `'market'`, so every shipped rule keeps meaning exactly what it meant. The rule stays the same two-dimensional filter it always was — **what** (`event_class` + `event_type`, `NULL` type = any type in the class) × **which subject** (`monitor_target_id`, `NULL` = any). This is **not** a rules engine: no thresholds, no quiet hours, no per-class predicates, no generalized subject narrowing. `conditions` remains an unused jsonb column.
5. **Detection and delivery stay separate concepts, and the seam is still explicit.** Nothing in event derivation, in `upsertHealth`, or in a domain service enqueues a delivery on its own. `publishNotificationEvent` records the event and then routes it, and callers pass the enqueue seam in — the injected-`TransactionalEnqueue` pattern `@loxep/infrastructure` already uses, so an emission inside a caller's transaction is genuinely part of that transaction.
6. **The ledger lives in `@loxep/domain`, the routing and delivery in `@loxep/notifications`.** This is forced and correct: `@loxep/inventory`, `@loxep/commerce`, and `@loxep/documents` cannot depend on `@loxep/notifications` (it depends on `@loxep/domain`), and every one of them already depends on `@loxep/domain`. It is the same reasoning that put `integration_health` in `@loxep/domain` rather than in the phase that introduced it: a shared foundation table written by many domains. Detection-side = `@loxep/domain`; endpoints, rules, transports, renderers, and the `notifications.deliver` task = `@loxep/notifications`.
7. **Not every detected state change is notifiable, by ruling.** Health transitions are notifiable only for Loxep's own integration subjects (`connection`, `notification_endpoint`, `storage_backend`). Fleet subjects (`external_resource`, `hosting_target`, `managed_domain`) are **not**: their alerts are the companion tools' own job and ntfy already unifies them (fleet design open question 1). The Gatus heartbeat endpoint named by `gatusPushSetting.endpointKey` is not an `integration_health` subject at all and therefore can never become a notification event — the feedback-latch quarantine is preserved structurally.

## Alternatives rejected

**Polymorphic subject columns on `notification_deliveries` (candidate 1).** Rejected on four counts. (a) It puts the *fact* in the delivery ledger, so an event with three endpoints stores its payload three times and "was this event notified?" becomes a `GROUP BY` instead of a row. (b) The dedupe key — the property that makes at-least-once delivery safe — would have to become a partial-unique pair on nullable columns, which is exactly the invariant we least want to weaken. (c) With the fact living on the delivery, an operator with no ntfy endpoint configured has **no in-app feed at all**, because nothing is recorded until something is routed. (d) It leaves the rule matcher and the ledger in the same market-shaped state for any consumer other than the delivery job. Its one genuine advantage — no new table — is not worth those four.

**Per-class delivery tables (candidate 3).** Rejected: it multiplies the delivery job, the retry/attempt accounting, the status union, and the `/settings` delivery table by the number of event classes, and every new class becomes a migration plus a new task. The delivery mechanics are the part of this subsystem that is genuinely domain-neutral already; splitting it is the one change that would make it less so.

**Keeping `market_event_id` alongside `notification_event_id`.** Rejected: two identity columns on one ledger, and the FK we would be preserving is the FK the finding is about. Market provenance survives as `subject_type = 'market_event'` + `subject_id`, which is exactly how `integration_health` and `reconcile_runs` already carry subject provenance.

**A `subject_type`/`subject_id` narrowing dimension on rules** (so a rule could target one acquisition or one connection). Rejected as a rules engine in disguise; the audit's own not-worth-wiring list names it. `monitor_target_id` stays the single subject narrowing because it already exists and market monitoring is the one place per-subject routing was actually asked for.

**Stamping the rendered title/body onto the event row at emission.** Rejected: it freezes message quality at emission time, duplicates text per delivery, and makes the renderer's purity pointless. The structured payload is smaller and renders better later.

## Consequences

- One new table and one changed foreign key on a shipped foundation table. Existing market deliveries are preserved by backfill, not discarded (pre-release, but there was no reason to destroy data for a change this mechanical).
- Every `market_events` row that reaches the bridge now also writes a `notification_events` row. That is one narrow row per *detected change* (not per observation), it inherits the market event's own deduplication key, and it is what makes an in-app feed possible for an installation with no transport configured. There is deliberately **no** retention policy, consistent with the rest of the observation/event schema.
- The product-shell notification bell can finally read something real — the same ledger, rendered by the same pure renderer as the outbound message.
- Adding an event class is: one registry entry in `@loxep/domain`, one renderer case, one emission call. Adding a class outside the seeded `CHECK` sets is a migration — a deliberate speed bump, and the seeds are wide enough that the classes already on the roadmap are covered.
- Two enqueue paths exist by design: the typed `AddJob` for the market path (poll executors already hold one) and the transactional raw `graphile_worker.add_job` seam for domain services inside their own transactions. `@loxep/infrastructure` set this precedent for the same reason — a pool-based enqueue silently loses atomicity.
