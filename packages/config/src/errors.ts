/**
 * Aggregate error types for bootstrap configuration and keyring validation.
 *
 * Error messages reference environment-variable names and structural facts
 * only. They must never contain secret values (connection-string credentials,
 * auth secrets, key material, SMTP passwords, OIDC client secrets).
 */

function formatIssues(kind: string, issues: readonly string[]): string {
  const noun = issues.length === 1 ? 'problem' : 'problems'
  const lines = issues.map((issue) => `  - ${issue}`).join('\n')
  return `${kind} (${issues.length} ${noun}):\n${lines}`
}

/** Thrown by `loadBootstrapConfig` with every detected problem listed. */
export class BootstrapConfigError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(formatIssues('Invalid bootstrap configuration', issues))
    this.name = 'BootstrapConfigError'
    this.issues = [...issues]
  }
}

/** Thrown by `parseKeyring` with every detected problem listed. */
export class KeyringError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(formatIssues('Invalid keyring', issues))
    this.name = 'KeyringError'
    this.issues = [...issues]
  }
}
