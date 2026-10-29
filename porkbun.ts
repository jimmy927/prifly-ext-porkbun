/**
 * The only file that talks to Porkbun: API v3 at one base URL, every call
 * signed with the two keys as the `X-API-Key` and `X-Secret-API-Key` headers
 * (so no body ever carries a key). Reads and writes alike come back as a
 * `Result`: the parsed answer, or one sentence for the session.
 */

import { type Creds, scrub } from "./credentials";

export const BASE = "https://api.porkbun.com/api/json/v3";

export type Method = "GET" | "POST";

/** What Porkbun answered: the HTTP status and the parsed JSON (or the text if it was not JSON). */
export type Sent = { status: number; body: unknown };

/** `failure` is the one sentence for the session; `body` is Porkbun's own error answer, when it sent one. */
export type Failure = { failure: string; body?: unknown };

export type Result<T> = { ok: T } | Failure;

export type Call = {
  method: Method;
  /** After `/api/json/v3/`, no leading slash: `dns/retrieve/example.com`. */
  path: string;
  body?: unknown;
  query?: Record<string, string>;
};

export function urlOf(path: string, query?: Record<string, string>): string {
  const url = new URL(`${BASE}/${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Where a domain's API access is switched on, for every domain at once or one by one. */
export const API_ACCESS_HINT =
  "Turn on Opt In All Domains at porkbun.com/account/api (it covers every domain, future ones too), or switch API Access on in that domain's Details under Domain Management.";

/** "Porkbun error: Invalid domain. (INVALID_DOMAIN)" — or the HTTP status when it said nothing. */
function sayError(status: number, body: unknown): string {
  const record = asRecord(body);
  const message = typeof record?.["message"] === "string" ? record["message"] : undefined;
  const code = typeof record?.["code"] === "string" ? ` (${record["code"]})` : "";
  const hint = record?.["code"] === "API_ACCESS_DISABLED" ? ` ${API_ACCESS_HINT}` : "";
  if (message !== undefined) return `Porkbun error: ${message}${code}${hint}`;
  return `Porkbun answered HTTP ${status}${typeof body === "string" && body !== "" ? `: ${body.slice(0, 300)}` : ""}`;
}

/**
 * Send one call. A transport error, a non-2xx answer and a `{status:"ERROR"}`
 * answer all come back as a `Failure`; keys are scrubbed from every sentence.
 */
export async function psend(creds: Creds, call: Call): Promise<Result<Sent>> {
  const headers: Record<string, string> = {
    "X-API-Key": creds.apikey,
    "X-Secret-API-Key": creds.secretapikey,
    Accept: "application/json",
  };
  const init: RequestInit = { method: call.method, headers };
  if (call.method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(call.body ?? {});
  }
  let response: Response;
  try {
    response = await fetch(urlOf(call.path, call.query), init);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return { failure: scrub(`Could not reach Porkbun: ${message}`, creds) };
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: the text stands as it is.
  }
  const failed = !response.ok || asRecord(body)?.["status"] === "ERROR";
  if (failed) {
    return { failure: scrub(sayError(response.status, body), creds), body: scrubbed(body, creds) };
  }
  return { ok: { status: response.status, body } };
}

function scrubbed(body: unknown, creds: Creds): unknown {
  return typeof body === "string"
    ? scrub(body, creds)
    : JSON.parse(scrub(JSON.stringify(body), creds));
}

/** Porkbun's warnings (a DNS write accepted for a domain that is not on its nameservers), as text to append. */
export function warningsOf(body: unknown): string {
  const warnings = asRecord(body)?.["warnings"];
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  return `\nPorkbun warns: ${warnings.map(String).join(" ")}`;
}

export function enc(part: string): string {
  return encodeURIComponent(part);
}

export function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
