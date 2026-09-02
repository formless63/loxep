/**
 * Browser-safe domain values.
 *
 * The main `@loxep/domain` entry point intentionally composes the complete
 * server domain, including database services, health probes, and encryption.
 * Isomorphic web modules must import runtime values from this narrow subpath
 * so Vite never traverses those Node-only implementations while constructing
 * the client graph.
 */

export { FLEET_EVIDENCE_PROVIDERS } from "./fleet-evidence.ts";
export type { FleetEvidenceProvider } from "./fleet-evidence.ts";

export { PROVIDER_WRITE_POLICY_TIERS } from "./provider-write-policy.ts";
export type { ProviderWritePolicyTier } from "./provider-write-policy.ts";
