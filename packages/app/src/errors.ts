/** Error hierarchy for @loxep/app (the composition root). */

export class AppError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A monitor target (or connection) is configured in a way the pipeline cannot
 * execute — e.g. an `ebay_item` target with no connection binding. This is a
 * DOMAIN error, not a provider failure: it is recorded as a poll failure with
 * backoff and never retried by Graphile.
 */
export class AppConfigurationError extends AppError {}

/** The eBay application keyset is absent or unusable. */
export class EbayKeysetMissingError extends AppConfigurationError {}
