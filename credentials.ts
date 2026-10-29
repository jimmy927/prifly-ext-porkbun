/**
 * The reader's Porkbun API keys. Porkbun signs every call with two keys (the
 * API key `pk1_…` and the secret API key `sk1_…`), and prifly's vault holds
 * one token per entry, so the entry `porkbun` holds both as one JSON text:
 *
 *     {"apikey": "pk1_…", "secretapikey": "sk1_…"}
 *
 * (Porkbun's own field names; `pk1_…:sk1_…` is read too.) They are read from
 * the vault at each call, never kept, never written to a file, and never in
 * a log line, a card or a tool's answer (`scrub`).
 */

import type { ExtensionApi } from "@prifly/extension-api";

/** The vault entry's name; the manifest's `vault` list names it too. */
export const VAULT_ENTRY = "porkbun";

export type Creds = { apikey: string; secretapikey: string };

export const NO_ENTRY = `Porkbun is not set up: there is no \`${VAULT_ENTRY}\` entry in prifly's vault. In Settings → Vault add an API-token entry named \`${VAULT_ENTRY}\` (level 1) whose token is {"apikey": "pk1_…", "secretapikey": "sk1_…"} — the two keys from porkbun.com/account/api, with API access switched on for the domains to use.`;

export const BAD_ENTRY = `The \`${VAULT_ENTRY}\` vault entry is not in the form this extension reads. Its token must be {"apikey": "pk1_…", "secretapikey": "sk1_…"} (or pk1_…:sk1_…).`;

/** The two keys in a vault token, or null when it is neither the JSON nor `key:secret`. */
export function parseCreds(token: string): Creds | null {
  const text = token.trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      return credsOf(record["apikey"], record["secretapikey"]);
    } catch {
      return null;
    }
  }
  const [apikey, secretapikey, ...rest] = text.split(":");
  return rest.length === 0 ? credsOf(apikey, secretapikey) : null;
}

function credsOf(apikey: unknown, secretapikey: unknown): Creds | null {
  if (typeof apikey !== "string" || typeof secretapikey !== "string") return null;
  const pair = { apikey: apikey.trim(), secretapikey: secretapikey.trim() };
  return pair.apikey === "" || pair.secretapikey === "" ? null : pair;
}

/** The keys in the vault, or the one sentence that says why there are none. */
export async function readCreds(
  api: Pick<ExtensionApi, "vault" | "log">,
): Promise<{ creds: Creds } | { refusal: string }> {
  let token: string | null | undefined;
  try {
    token = await api.vault?.read(VAULT_ENTRY);
  } catch (caught) {
    api.log("vault_read_failed", { message: caught instanceof Error ? caught.message : "failed" });
    return { refusal: NO_ENTRY };
  }
  if (typeof token !== "string" || token.trim() === "") return { refusal: NO_ENTRY };
  const creds = parseCreds(token);
  return creds === null ? { refusal: BAD_ENTRY } : { creds };
}

/** `text` with both keys replaced by `[redacted]`, for anything shown or returned. */
export function scrub(text: string, creds: Creds): string {
  let out = text;
  for (const secret of [creds.apikey, creds.secretapikey]) {
    if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  }
  return out;
}
