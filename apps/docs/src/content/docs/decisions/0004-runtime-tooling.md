---
title: "ADR-0004: Runtime and Tooling"
---

# ADR-0004: Node.js runtime with Bun workspace/tooling

**Status:** Accepted

## Context

Bun has become a strong package manager and TypeScript development tool, while core Loxep infrastructure such as Graphile Worker targets Node.js directly. Using different production runtimes for web and worker processes adds compatibility surface without providing meaningful product value.

## Decision

Use:

- current supported Node.js LTS as the production runtime baseline;
- Bun for package installation, lockfile, workspaces, scripts, and development tooling where compatible;
- TypeScript and ESM throughout application packages.

Do not depend on Bun-runtime-specific APIs in shared/domain packages unless a later ADR deliberately changes the production runtime policy.

## Consequences

- Developers receive Bun's package/workspace ergonomics without making runtime compatibility a foundational risk.
- Production processes share one runtime family.
- The exact Node LTS version may advance over the project's life without changing this ADR.
- Bun may become a supported production runtime later after dependency/runtime compatibility is demonstrated.
