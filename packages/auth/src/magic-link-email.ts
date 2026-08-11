/**
 * Magic-link email delivery over SMTP (ADR-0007, ADR-0016).
 *
 * Delivery is isolated behind the `SendMagicLinkEmail` function type so the
 * web layer uses a real nodemailer transport built from bootstrap SMTP
 * configuration while tests inject a capturing sender instead of sending.
 */
import nodemailer from "nodemailer";
import type { SmtpBootstrapConfig } from "@loxep/config";

export interface MagicLinkEmail {
  /** Recipient address (the address that requested sign-in). */
  to: string;
  /** Fully-formed verification URL the recipient must open. */
  url: string;
  /** Raw verification token (embedded in `url`; exposed for custom flows/tests). */
  token: string;
}

/** Injectable delivery function; tests capture instead of sending. */
export type SendMagicLinkEmail = (email: MagicLinkEmail) => Promise<void>;

/**
 * Build the real SMTP sender from bootstrap configuration
 * (`LOXEP_SMTP_URL` + `LOXEP_SMTP_FROM`). The transport connects lazily on
 * first send, so constructing the sender performs no I/O.
 */
export function createSmtpMagicLinkSender(
  smtp: SmtpBootstrapConfig,
): SendMagicLinkEmail {
  const transport = nodemailer.createTransport(smtp.url);
  return async ({ to, url }) => {
    await transport.sendMail({
      from: smtp.from,
      to,
      subject: "Sign in to Loxep",
      text: [
        "Open this link to sign in to Loxep:",
        "",
        url,
        "",
        "The link expires shortly and can be used once.",
        "If you did not request this sign-in, you can ignore this email.",
      ].join("\n"),
    });
  };
}
