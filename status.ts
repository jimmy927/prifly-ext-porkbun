/**
 * The extension's one line in Settings → Extensions (`api.status`):
 * "Connected · pork_user · 7 domains", or what to add. Porkbun is asked at
 * activation and then at most every 15 minutes; the line never carries a key.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { readCreds, VAULT_ENTRY } from "./credentials";
import { psend } from "./porkbun";
import { listDomains } from "./tools-domains";

export const STATUS_EVERY_MS = 15 * 60 * 1000;

export type StatusLine = {
  /** Read Porkbun again; never rejects. */
  refresh: () => Promise<void>;
  stop: () => void;
};

/** Runs `tick` every `ms` until the returned stop is called; a test passes one it drives itself. */
export type Every = (tick: () => void, ms: number) => () => void;

const realEvery: Every = (tick, ms) => {
  const timer = setInterval(tick, ms);
  return () => clearInterval(timer);
};

/** The line for the keys in the vault now. */
async function lineOf(api: ExtensionApi): Promise<string> {
  const found = await readCreds(api);
  if ("refusal" in found) return `Not set up: add a \`${VAULT_ENTRY}\` entry to prifly's vault`;
  const ping = await psend(found.creds, { method: "POST", path: "ping" });
  if (!("ok" in ping)) return `Not connected: ${ping.failure}`;
  const account = (ping.ok.body as { account?: string }).account;
  const owned = await listDomains(found);
  const count =
    "domains" in owned
      ? `${owned.domains.length} domain${owned.domains.length === 1 ? "" : "s"}`
      : "domains unreadable";
  return ["Connected", ...(account === undefined ? [] : [account]), count].join(" · ");
}

export function startStatus(api: ExtensionApi, every: Every = realEvery): StatusLine {
  let stopped = false;

  const refresh = async (): Promise<void> => {
    try {
      const line = await lineOf(api);
      if (!stopped) api.status?.(line);
    } catch (error) {
      api.log("status_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  };
  const stopTimer = every(() => void refresh(), STATUS_EVERY_MS);
  void refresh();
  return {
    refresh,
    stop: () => {
      stopped = true;
      stopTimer();
    },
  };
}
