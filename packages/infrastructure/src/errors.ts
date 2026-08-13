/**
 * Infrastructure domain errors.
 *
 * These are DOMAIN errors, not adapter errors: a provider's five-kind taxonomy
 * stops at the integration boundary (ADR-0009) and reaches this package only as
 * a `kind` string on a {@link ProviderCallError}. Nothing here imports an
 * integration package.
 */

export class InfrastructureError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "InfrastructureError";
    this.detail = detail;
  }
}

/** Invalid operator intent — a bad name, a cycle, a missing reference. */
export class InfrastructureValidationError extends InfrastructureError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, detail);
    this.name = "InfrastructureValidationError";
  }
}

export class InfrastructureNotFoundError extends InfrastructureError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, detail);
    this.name = "InfrastructureNotFoundError";
  }
}

/**
 * Materialization could not produce a safe desired-record set.
 *
 * This is deliberately an ERROR rather than a partial result. The two cases
 * that raise it — a broken fronting chain and a proxying intent the provider
 * cannot honor — both have a "helpful" fallback that publishes something
 * wrong: the origin's address for a host that exists to be hidden, or an
 * unproxied record the operator believes is proxied. The design's rule is
 * explicit: *"a broken chain is an error, not a fallback."*
 */
export class MaterializationError extends InfrastructureError {
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message, detail);
    this.name = "MaterializationError";
  }
}

/**
 * A provider call failed. `kind` is the adapter's taxonomy kind, carried
 * across the boundary as a plain string so this package needs no dependency on
 * the adapter that produced it.
 */
export class ProviderCallError extends InfrastructureError {
  readonly kind: string;
  constructor(
    kind: string,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message, detail);
    this.name = "ProviderCallError";
    this.kind = kind;
  }
}
