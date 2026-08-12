---
title: "ADR-0021: Order-Payload Retention in provider_objects"
---

**Status:** PROVISIONAL — decided and scheduled for implementation per the delegated-decision policy; awaiting owner review. Refines foundational decision 7 (raw provider-object retention) for one object class; does not supersede it.

## Context

Foundational decision 7 retains `provider_objects` snapshots with hash-deduplication and "no automatic retention/deletion policy by default." Commerce ingestion (Phase 3) broke the assumption behind that stance: order payloads carry buyer personal data — billing/shipping addresses, email, phone, customer IP, user agent — that marketplace observation payloads never contain. Live verification against a production WooCommerce store confirmed the exposure is real, and the Woo adapter already ships a `redactWooOrderFact` helper pending this policy (Commerce Schema Design, open question 8, deliberately left unimplemented).

Hash-deduplication bounds growth (one row per distinct payload per order) but is not a retention policy: an address stored once is stored indefinitely.

## Decision

Order-class provider object payloads are **redacted by default after 180 days; provenance rows are never automatically deleted.**

1. **Redaction, not deletion.** After the retention window, the stored payload is replaced by its provider-specific redacted form (for WooCommerce, `redactWooOrderFact`; every adapter that gains order ingestion must ship an equivalent redaction helper as part of that work). The `provider_objects` row itself — identity, provider, object type, payload hash, timestamps — is retained. Data-minimization is achieved by removing personal data from the payload, not by destroying provenance.
2. **Default window: 180 days** from the payload row's storage time. Rationale: typical marketplace dispute, return, and chargeback windows run to ~180 days; the payload's support value (looking up a buyer address for a return) decays with them. The window applies per stored payload row, not per order, so a re-synced order that produced a newer payload keeps its newest facts longest.
3. **Configurable in PostgreSQL, not env.** A registered application setting `commerce.order_payload_retention` (shape: `{ mode: 'redact' | 'keep', afterDays: 180 }`) declared in `@loxep/domain` settings-defaults so it is visible and editable from `/settings`, per ADR-0016 conventions. `mode: 'keep'` restores the old behavior for installations that want it; there is no automatic hard-delete mode.
4. **`order_source_links` are unaffected.** Links reference the provenance row, which persists through redaction; nothing dangles. Hard deletion of provider objects remains an explicit operator action, out of scope for automation.
5. **Scope: order-class objects only.** All other provider object classes, and `source_events`, keep foundational decision 7's retain-by-default stance unchanged.
6. **Semantics after redaction:** `payload_hash` keeps identifying the *original* payload (it remains the dedup/identity key; an unchanged re-sync must still match it), so after redaction the stored payload no longer hashes to `payload_hash`. The implementation records `redacted_at` on the row to make that state explicit. Redaction is idempotent and at-least-once safe: redacting a redacted payload is a no-op.

## Consequences

- Buyer PII exposure in the database becomes time-bounded by default while replay/debugging provenance and duplicate detection survive.
- Ingestion re-sync of an old, unchanged order after redaction matches the existing row by `payload_hash` and re-stores nothing — the redacted state persists, which is the intended outcome.
- Full-payload replay is only possible within the window (or with `mode: 'keep'`); anything the domain schema needs long-term must be normalized into columns, which is already the design's direction (buyer identity columns hold an external id and channel handle only).
- The retention sweep is a small dispatcher-style Graphile Worker job over DB-stored state, consistent with the scheduling architecture; implementation is tracked separately (see the implementation issue created alongside this ADR).
