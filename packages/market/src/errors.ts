/** Error hierarchy for @loxep/market. */

export class MarketError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input failed schema/shape validation before touching the database. */
export class MarketValidationError extends MarketError {}

/** A referenced monitor target / marketplace item does not exist. */
export class MarketNotFoundError extends MarketError {}
