/** Error hierarchy for @loxep/notifications. */

export class NotificationsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Input failed schema/shape validation before touching the database. */
export class NotificationValidationError extends NotificationsError {}

/** A referenced endpoint/rule/event/delivery does not exist. */
export class NotificationNotFoundError extends NotificationsError {}

/** A transport attempt failed (network/HTTP); retryable by the job system. */
export class NotificationTransportError extends NotificationsError {
  readonly status: number | null;

  constructor(
    message: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.status = options?.status ?? null;
  }
}
