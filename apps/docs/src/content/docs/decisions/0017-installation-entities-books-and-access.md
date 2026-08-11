---
title: "ADR-0017: Economic Entities, Accounting Books, and Initial Access"
---

## Status

Accepted for foundation implementation.

## Context

A Loxep installation is intended for one person or a small group of trusted people sharing one environment. It is not a SaaS tenant container. The same installation may nevertheless represent activity belonging to several distinct people, businesses, or operating identities.

Examples include personal marketplace activity, a sole proprietorship, one or more LLCs, partnerships, corporations, and assumed-name/DBA operations. A different Loxep installation could represent one of those businesses directly and be shared with that business's partners.

These concepts must not be collapsed into application users, provider connections, workspaces, or SaaS organizations.

Accounting adds another independent concern: the thing Loxep treats as an operational/economic entity is not necessarily the same boundary as a set of accounting books. Multiple operating identities may share one chart of accounts and ledger. An LLC with multiple assumed names is a common example: the operating identities may be useful for attribution and reporting while the accounting separation is handled inside one book through accounts, dimensions, or other classification.

## Decision

### One installation, installation-wide membership

The initial authorization model is deliberately simple:

- Better Auth owns installation users and the deployment-level roles `admin` and `member`.
- Both roles have access to ordinary product data across the installation.
- `admin` is reserved for installation/security/administrative operations that genuinely require elevated authority.
- Phase 0 does **not** implement per-connection, per-workspace, or per-economic-entity ACLs.
- Fine-grained resource authorization may be added later when a real workflow requires it.

Membership grants access to the installation. Economic entities classify operational ownership/context; they are not permission containers.

### Economic entities are first-class foundation records

Add a minimal `economic_entities` concept during Phase 0. It represents a person, business, or operating identity whose activity Loxep may attribute and analyze.

The term is intentionally broader than "legal entity." Useful records may include:

- an individual/personal activity context;
- a sole proprietorship;
- an LLC, partnership, or corporation;
- an assumed name/DBA or operating identity beneath another entity;
- another explicitly tracked economic/operating context.

An optional parent relation may express relationships such as an assumed name beneath an LLC without pretending that every child is a separate legal person.

### Provider connections may be attributed to an economic entity

Connections gain a nullable `economic_entity_id`.

Use it where the external account/store clearly belongs to or primarily represents one economic entity, such as a business eBay account or bank account. Leave it null where ownership is shared, not meaningful, or not yet known.

Connection attribution is context, not authorization. A connection's creator is also not its owner for access-control purposes.

### Economic entities are not counterparties

An organization may appear in one installation as an entity whose activity Loxep is operating, and in another installation merely as a customer, vendor, payer, or other counterparty.

Do not use the future customer/vendor/party model as a substitute for installation-owned economic entities, and do not assume every organization record represents books owned by this installation.

### Accounting books are a separate future concept

Do not equate `economic_entity` with `accounting_book` or ledger.

When the Accounting domain is implemented, model books explicitly. A book owns concerns such as:

- chart of accounts;
- fiscal periods;
- posting controls/rules;
- journal entries and financial statements.

The model must support more than one economic entity/operating identity participating in the same accounting book. Separation between those activities may be expressed through the chart of accounts, dimensions, classes, departments, or another accounting classification model selected later.

Therefore Phase 0 must **not** add a required `accounting_book_id` to `economic_entities`. The Accounting phase should introduce an explicit book-to-entity relationship whose cardinality can reflect real accounting needs.

## Initial schema direction

Phase 0 adds a small table equivalent to:

```text
economic_entities
├── id
├── name
├── kind
├── parent_entity_id nullable
├── legal_name nullable
├── active
├── created_at
└── updated_at
```

`kind` remains an application-owned text value rather than a PostgreSQL enum. Initial useful values may include `individual`, `sole_proprietorship`, `llc`, `partnership`, `corporation`, `assumed_name`, `operating_unit`, and `other`; implementation should not encode tax/legal conclusions from the label alone.

`connections.economic_entity_id` is nullable.

Phase 0 removes the planned `connection_users` ACL table. `created_by_user_id` fields remain useful audit/provenance metadata but do not confer private ownership.

## Consequences

- A single installation can cleanly contain personal and multiple-business activity without becoming multi-tenant.
- Trusted collaborators can share one installation without an unnecessary initial permission matrix.
- Provider accounts are not confused with legal/accounting ownership.
- Assumed names and operating identities can be represented without forcing separate books.
- Accounting can later support one book spanning multiple economic entities/operating identities rather than inheriting a one-entity-one-ledger mistake from the operational schema.
- Fine-grained ACLs remain possible later without making them a Phase 0 prerequisite.
