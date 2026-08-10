---
title: "ADR-0008: UI System"
---

# ADR-0008: shadcn/ui with owned component source

**Status:** Accepted

## Context

Loxep will contain a large number of data-heavy administrative surfaces. Building every primitive and common component from headless libraries would consume time without differentiating the product. Fully packaged design systems such as Mantine or Chakra accelerate initial work but place more of the application's visual/component architecture behind a dependency boundary.

## Decision

Use Tailwind CSS and shadcn/ui as the initial component system, using the current supported primitive foundation selected by shadcn at scaffold time unless a component has a concrete accessibility/behavior reason to use another primitive.

Component source is owned in the repository and may be adapted to Loxep rather than treated as an immutable upstream package API.

Use Lucide for the baseline icon set.

## Consequences

- Fast access to common application components without surrendering source ownership.
- UI consistency becomes Loxep's responsibility as components are customized.
- Raw Base UI/React Aria/Radix primitives remain available where specialized behavior warrants them.
- Avoid adding a second comprehensive component framework alongside shadcn.
