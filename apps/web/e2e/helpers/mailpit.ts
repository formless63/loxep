/**
 * Mailpit REST helpers for magic-link capture.
 *
 * The e2e harness points Loxep's SMTP bootstrap config at a local Mailpit
 * instance (`smtp://localhost:1025`); Mailpit's REST API
 * (http://localhost:8025/api/v1 by default) exposes captured messages so
 * tests can fetch and consume magic-link sign-in URLs without a real
 * mailbox. All deletion is scoped with `to:` search queries so a Mailpit
 * instance shared with other local projects is never wiped wholesale.
 */

const MAILPIT_API = process.env['LOXEP_E2E_MAILPIT_API'] ?? 'http://localhost:8025/api/v1';

interface MailpitSearchResult {
  messages: { ID: string; Created: string }[];
}

function searchUrl(email: string): string {
  return `${MAILPIT_API}/search?query=${encodeURIComponent(`to:"${email}"`)}`;
}

/** Delete every captured message addressed to `email` (and only those). */
export async function deleteMessagesFor(email: string): Promise<void> {
  const res = await fetch(searchUrl(email), { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(`Mailpit delete for ${email} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Poll Mailpit until a message for `email` arrives, extract the magic-link
 * verification URL from its plain-text body, then delete the message so the
 * next sign-in for the same address starts from an empty mailbox.
 */
export async function waitForMagicLink(
  email: string,
  { timeoutMs = 15_000, pollMs = 250 }: { timeoutMs?: number; pollMs?: number } = {}
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(searchUrl(email));
    if (!res.ok) {
      throw new Error(`Mailpit search for ${email} failed: ${res.status} ${await res.text()}`);
    }
    const result = (await res.json()) as MailpitSearchResult;
    const newest = result.messages[0];
    if (newest) {
      const detail = await fetch(`${MAILPIT_API}/message/${newest.ID}`);
      if (!detail.ok) {
        throw new Error(`Mailpit message fetch failed: ${detail.status}`);
      }
      const body = (await detail.json()) as { Text: string };
      const match = body.Text.match(/https?:\/\/\S+\/api\/auth\/\S+/);
      if (!match) {
        throw new Error(`No magic-link URL found in message to ${email}:\n${body.Text}`);
      }
      await deleteMessagesFor(email);
      return match[0];
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for a magic-link email to ${email}`);
}
