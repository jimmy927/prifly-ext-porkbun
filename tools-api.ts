/**
 * `porkbun_api`: any other Porkbun API v3 call (register a domain,
 * nameservers, URL forwarding, ...). A pure read runs at once; anything else
 * shows the reader a confirm card first, with every money amount in dollars
 * (Porkbun takes pennies: `cost: 1108` is $11.08).
 */

import { scrub } from "./credentials";
import { type Call, type Failure, type Method, psend, usd } from "./porkbun";
import { fitText, type Ready, stringArg, type ToolSpec } from "./tools-common";
import { confirmedSend } from "./write";

/** The POST endpoints that only read, by the start of their path after `/api/json/v3/`. */
const READS =
  /^(?:ping|ip|pricing\/get|domain\/(?:checkDomain|listAll|getNs|getGlue|getUrlForwarding)(?:\/|$)|dns\/(?:retrieve|retrieveByNameType|getDnssecRecords)(?:\/|$)|email\/(?:getForwards|getMailboxes)(?:\/|$)|marketplace\/getAll$)/;

/**
 * Whether a call changes nothing and returns nothing secret. A GET reads,
 * except `ssl/` (it returns the certificate's private key); a POST reads only
 * on the list above, and always with a `dryRun` it is still a card.
 */
export function isRead(method: Method, path: string): boolean {
  if (path.startsWith("ssl/")) return false;
  return method === "GET" || READS.test(path);
}

const NOT_A_PATH =
  "`path` is the part after /api/json/v3/, like domain/listAll or dns/retrieve/example.com.";

/** The path without a leading slash or the base; null when it is not a Porkbun v3 path. */
export function cleanPath(text: string): string | null {
  const path = text
    .trim()
    .replace(/^\/+/, "")
    .replace(/^api\/json\/v3\//, "");
  if (
    path === "" ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    /[\s\\?#]|(?:^|\/)\.\.?(?:\/|$)/.test(path)
  )
    return null;
  return /^[\w\-./%@:~]+$/.test(path) ? path : null;
}

/** Amounts Porkbun takes in US cents, by their field name in a body. */
const MONEY: Record<string, string> = {
  cost: "Cost",
  amount: "Amount",
  threshold: "Below a balance of",
  acknowledgedCost: "Price acknowledged",
};

function moneyLines(body: Record<string, unknown>): string[] {
  return Object.entries(MONEY)
    .filter(([key]) => typeof body[key] === "number")
    .map(([key, label]) => `${label}: ${usd(body[key] as number)} (sent as ${body[key]} cents)`);
}

/** A money field that is not whole cents is refused before anything is shown. */
function badMoney(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(MONEY)) {
    const value = body[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0))
      return `\`${key}\` is in US cents (pennies) as a whole number: 1108 is $11.08.`;
  }
  return null;
}

type Words = { title: string; summary: string };

function paidWith(body: Record<string, unknown>): string {
  if (body["payWith"] === "card") return ", paid by card";
  if (body["payWith"] === "usdc") return ", paid in USDC";
  return ", taken from your Porkbun account credit";
}

const cost = (body: Record<string, unknown>): string =>
  typeof body["cost"] === "number" ? usd(body["cost"]) : "the price you gave";

/** The card's title and one plain sentence for the calls worth naming; a general one for the rest. */
export function describe(path: string, body: Record<string, unknown>): Words {
  const [group, action, rest] = path.split("/");
  const target = rest === undefined ? "" : decodeURIComponent(rest);
  switch (`${group}/${action}`) {
    case "domain/create":
      return {
        title: "Register a domain",
        summary: `Register ${target} for ${cost(body)}${paidWith(body)}.`,
      };
    case "domain/renew":
      return {
        title: "Renew a domain",
        summary: `Renew ${target} for ${cost(body)}${paidWith(body)}.`,
      };
    case "domain/transfer":
      return {
        title: "Transfer a domain in",
        summary: `Transfer ${target} to Porkbun for ${cost(body)}${paidWith(body)}.`,
      };
    case "domain/updateAutoRenew":
      return {
        title: "Change auto-renew",
        summary: `Turn auto-renew ${String(body["status"] ?? "?")} for ${target}.`,
      };
    case "domain/updateNs":
      return {
        title: "Change nameservers",
        summary: `Change the nameservers of ${target} to ${Array.isArray(body["ns"]) ? body["ns"].join(", ") : "?"}.`,
      };
    case "domain/addUrlForward":
      return { title: "Add a URL forward", summary: `Add a URL forward on ${target}.` };
    case "domain/deleteUrlForward":
      return { title: "Remove a URL forward", summary: `Remove a URL forward from ${target}.` };
    case "account/topup":
      return {
        title: "Top up account credit",
        summary: `Charge your saved card ${typeof body["amount"] === "number" ? usd(body["amount"]) : "your account's top-up amount"} to add Porkbun account credit.`,
      };
    default:
      return {
        title: "Change something at Porkbun",
        summary: `Make the Porkbun API call ${path}.`,
      };
  }
}

function contentOf(path: string, body: Record<string, unknown>): string {
  const lines = [`Call: ${path}`, ...moneyLines(body)];
  if (body["dryRun"] === true)
    lines.push("Dry run: Porkbun only checks; nothing is bought or changed.");
  return lines.join("\n");
}

/** The body as an object without the key fields: the keys go in headers, whatever the session wrote. */
function bodyOf(value: unknown): { body: Record<string, unknown> } | { refusal: string } {
  if (value === undefined) return { body: {} };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { refusal: "`body` is a JSON object." };
  const body = { ...(value as Record<string, unknown>) };
  delete body["apikey"];
  delete body["secretapikey"];
  return { body };
}

function queryOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, String(each)]));
}

function answerText(ready: Ready, body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return fitText(scrub(text, ready.creds), ready, "porkbun-api");
}

/** The request the session described, checked: the call to make and its body, or why not. */
function requestOf(
  args: Record<string, unknown>,
): { call: Call; body: Record<string, unknown> } | { refusal: string } {
  const method = stringArg(args, "method")?.toUpperCase();
  if (method !== "GET" && method !== "POST") return { refusal: "`method` is GET or POST." };
  const path = cleanPath(stringArg(args, "path") ?? "");
  if (path === null) return { refusal: NOT_A_PATH };
  const given = bodyOf(args["body"]);
  if ("refusal" in given) return given;
  const { body } = given;
  const query = queryOf(args["query"]);
  const bad = badMoney(body);
  if (bad !== null) return { refusal: bad };
  const call: Call = {
    method,
    path,
    ...(Object.keys(query).length === 0 ? {} : { query }),
    ...(method === "POST" ? { body } : {}),
  };
  return { call, body };
}

/** Porkbun's one-sentence error, with its own answer under it (a `payUrl`, a `shortfall`). */
function failureText(ready: Ready, failure: Failure): string {
  return failure.body === undefined
    ? failure.failure
    : `${failure.failure}\n${answerText(ready, failure.body)}`;
}

async function runApi(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const request = requestOf(args);
  if ("refusal" in request) return request.refusal;
  const { call, body } = request;
  if (isRead(call.method, call.path)) {
    const read = await psend(ready.creds, call);
    return "ok" in read ? answerText(ready, read.ok.body) : failureText(ready, read);
  }
  const words = describe(call.path, body);
  const answer = await confirmedSend(ready, {
    ...call,
    ...words,
    content: contentOf(call.path, body),
  });
  if ("cancelled" in answer) return answer.cancelled;
  if (!("ok" in answer)) return failureText(ready, answer);
  return `Porkbun accepted it: ${words.summary}\n${answerText(ready, answer.ok.body)}`;
}

export const apiTool: ToolSpec = {
  name: "porkbun_api",
  description:
    'Any Porkbun API v3 call, as the reader\'s account: registering or renewing a domain (domain/create/{domain}, with `cost` in pennies from porkbun_check and agreeToTerms "yes"), nameservers (domain/updateNs/{domain}), auto-renew, URL forwarding, account balance, and the rest of https://porkbun.com/api/json/v3/documentation. A pure read runs at once; any other call shows the reader a confirm card first, with money in dollars, and nothing is sent if they cancel. Keys are added for you: never put them in `body`.',
  properties: {
    method: {
      type: "string",
      enum: ["GET", "POST"],
      description: "Porkbun reads accept GET; writes are POST.",
    },
    path: {
      type: "string",
      description:
        "After /api/json/v3/, e.g. domain/getNs/example.com or domain/updateNs/example.com.",
    },
    body: {
      type: "object",
      description:
        "POST: the JSON body, without apikey or secretapikey. Money fields are US cents.",
    },
    query: { type: "object", description: "GET: query parameters, as strings." },
  },
  required: ["method", "path"],
  run: runApi,
};
