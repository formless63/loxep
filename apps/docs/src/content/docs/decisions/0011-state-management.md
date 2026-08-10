---
title: "ADR-0011: Client State Management"
---

**Status:** Accepted; clarified after the initial UI scaffold.

## Context

Loxep has natural owners for most application state: PostgreSQL for durable state, TanStack Query for server/cache state, Router for URL/navigation state, TanStack Form for form state, and React for local component state.

The adopted Kiranism dashboard includes Zustand, and Loxep has credible near-term uses for cross-component editing/workspace state such as configurable dashboards, chart/view configuration, table layouts, and other interactions that benefit from a small client store.

The risk is not Zustand itself. The risk is turning it into a second home for server or durable product state.

## Decision

Retain Zustand in the frontend dependency set while keeping its ownership narrow.

Use Zustand for concrete cross-component **ephemeral/editing UI state** that is not naturally URL, server/cache, form, or local component state.

For durable user customization, use the pattern:

```text
interactive editing state
       (Zustand)
          |
          v
   validated save
          |
          v
 durable preference
    (PostgreSQL)
```

Examples include dashboard widget position/size during editing, chart configuration, visible/reordered columns, multi-panel UI selections, or other workspace state where immediate cross-component updates are useful.

Do not mirror TanStack Query data or canonical PostgreSQL records into a global Zustand store merely for convenience.

## Consequences

- Zustand is an intentional available tool rather than donor baggage to remove reflexively.
- Server data remains owned by Query/domain APIs.
- URL-shareable state remains owned by Router.
- Forms remain owned by TanStack Form.
- Device/browser-independent user preferences are persisted to PostgreSQL when they need to survive sessions/devices.
- New global state still requires an explicit ownership justification.
