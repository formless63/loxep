---
title: Dependency and Version Policy
---

# Dependency and Version Policy

Loxep should not adopt stale framework, runtime, library, container, or GitHub Action versions simply because they are familiar, widely represented in training data, or present in an older example.

## Core rule

Before adding or pinning a dependency, verify the current upstream stable release and confirm that it is viable with the rest of the selected stack.

Do not assume a remembered major version is current.

## Selection policy

1. Prefer the newest stable release that is compatible with Loxep's supported runtime and peer dependencies.
2. Do not select an older version without documenting the reason when a newer stable release exists.
3. Avoid prerelease/canary/nightly versions unless a documented requirement justifies the risk.
4. Verify breaking changes and peer-dependency compatibility before adopting a new major.
5. Prefer primary sources for version verification: official release pages, package registries, official documentation, and upstream changelogs.
6. For major architectural dependencies, record intentional version constraints or compatibility exceptions in the relevant ADR.

## Reproducibility

Application dependencies should be represented by deterministic manifests and lockfiles. Avoid `latest` in committed package manifests because it makes the same commit resolve differently over time.

Exact versions are acceptable and preferred for application/tooling dependencies when automated update tooling keeps them current. Peer dependencies in publishable libraries may use appropriate compatible ranges.

CI actions should use explicit verified release versions rather than obsolete examples. Security-oriented SHA pinning may be introduced where appropriate, provided automated tooling is configured to keep the pinned digest current.

## Automated updates

Loxep intends to use Renovate for dependency maintenance because it supports Bun manifests/lockfiles as well as GitHub Actions.

Automated updates do not remove the requirement to review major-version migrations. The desired workflow is:

- Renovate detects a new stable release;
- CI builds and tests the proposed update;
- breaking changes are reviewed where relevant;
- the dependency remains current rather than silently aging for years.

Lockfile maintenance should also be automated once the application workspace and root Bun lockfile are established.

## Agent instructions

When an agent introduces a dependency or changes a version, it should:

1. Check the current stable version from an upstream/current source.
2. Check compatibility with the project's runtime and related dependencies.
3. Use that version unless there is a concrete reason not to.
4. State/document the reason if deliberately selecting an older version.
5. Update lockfiles and CI where applicable.

Examples copied from documentation should be treated as examples, not authoritative current version pins.
