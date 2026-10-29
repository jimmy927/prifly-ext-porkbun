/**
 * The one road for a call that changes something at Porkbun: every write a
 * tool makes goes through `confirmedSend`, which shows the reader a confirm
 * card (`api.confirm`) and sends nothing unless they press Confirm. The card
 * reads top down: one plain sentence (`summary`), what is being changed in
 * plain text (`content`), and only under a closed "Details" toggle the
 * request itself (`details`: method, URL, JSON body). The keys are in
 * headers and never on the card.
 */

import { scrub } from "./credentials";
import { type Call, type Method, psend, type Result, type Sent, urlOf } from "./porkbun";
import type { Ready } from "./tools-common";

export const CANCELLED = "Not done: you cancelled";

export const NO_CONFIRM =
  "Not done: this prifly cannot show a confirm card, so the extension makes no changes. Update prifly.";

export type Write = {
  method: Method;
  /** After `/api/json/v3/`: `dns/create/example.com`. */
  path: string;
  body?: unknown;
  query?: Record<string, string>;
  /** The card's title, a few words: "Add a DNS record". */
  title: string;
  /** One plain sentence, no URL or JSON: "Add an A record for www.example.com pointing to 1.2.3.4." */
  summary: string;
  /** The human part in plain text: the record, the purchase or the setting being changed. */
  content?: string;
};

const KEYS_NOTE =
  "Sent with your porkbun vault keys in the X-API-Key and X-Secret-API-Key headers (not shown).";

/** The card's Details block: exactly the request that goes out, minus the keys. */
export function requestText(method: Method, url: string, body: unknown): string {
  const head = `${method} ${url}`;
  const request = body === undefined ? head : `${head}\n\n${JSON.stringify(body, null, 2)}`;
  return `${request}\n\n${KEYS_NOTE}`;
}

/**
 * Ask the reader, then send. `{ cancelled }` carries the sentence for the
 * session when nothing was sent.
 */
export async function confirmedSend(
  ready: Ready,
  write: Write,
): Promise<Result<Sent> | { cancelled: string }> {
  const confirm = ready.api.confirm;
  if (confirm === undefined) return { cancelled: NO_CONFIRM };
  const url = urlOf(write.path, write.query);
  const shown = (text: string) => scrub(text, ready.creds);
  let yes: boolean;
  try {
    yes = await confirm({
      title: write.title,
      summary: shown(write.summary),
      ...(write.content === undefined ? {} : { content: shown(write.content) }),
      details: shown(requestText(write.method, url, write.body)),
    });
  } catch (error) {
    // No answer from the card is no consent: nothing is sent, and the session is told why.
    const message = error instanceof Error ? error.message : String(error);
    ready.api.log("confirm_failed", { method: write.method, path: write.path, message });
    return { cancelled: `Not done: the confirm card could not be shown (${message})` };
  }
  if (!yes) {
    ready.api.log("write_cancelled", { method: write.method, path: write.path });
    return { cancelled: CANCELLED };
  }
  ready.api.log("write", { method: write.method, path: write.path });
  const call: Call = {
    method: write.method,
    path: write.path,
    ...(write.body === undefined ? {} : { body: write.body }),
    ...(write.query === undefined ? {} : { query: write.query }),
  };
  return await psend(ready.creds, call);
}
