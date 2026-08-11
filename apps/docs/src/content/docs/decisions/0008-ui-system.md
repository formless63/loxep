---
title: "ADR-0008: shadcn/ui with owned component source"
---

**Status:** Accepted; expanded by ADR-0015.

## Context

Loxep will contain many data-heavy administrative surfaces. Building every primitive, dashboard layout, theme, and common component from scratch would spend early effort on solved presentation work.

## Decision

Use Tailwind CSS and shadcn/ui as the initial component system, with Base UI as the primary primitive layer where aligned with the current shadcn implementation.

Component source is owned in the repository and may be adapted to Loxep rather than treated as an immutable upstream package API.

Use Lucide as the baseline icon set.

ADR-0015 selects Kiranism's TanStack Start dashboard as the initial UI foundation and donor. Reuse/adapt its responsive shell, theme system, shadcn/Base UI composition, navigation, table/form patterns, and useful application states.

Do not automatically inherit its demo domain, backend/auth implementation, global state choices, charting library, unnecessary features, or dependency versions.

## Consequences

- Loxep starts with a polished responsive shell and multi-theme system rather than a blank UI.
- Common components remain directly editable in the Loxep repository.
- UI consistency becomes Loxep's responsibility as starter/components are customized.
- Other maintained primitives remain available where specialized behavior warrants them.
- Avoid adding a second comprehensive component framework alongside shadcn.
