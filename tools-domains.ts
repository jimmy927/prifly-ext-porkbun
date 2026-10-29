/**
 * Domains: `porkbun_domains` (what the account holds, with expiry and
 * auto-renew) and `porkbun_check` (whether names are free, and the price).
 * Both only read. Porkbun prices in these answers are dollars, as strings.
 */

import { psend } from "./porkbun";
import {
  cleanDomain,
  fitText,
  intArg,
  NOT_A_DOMAIN,
  orSentence,
  type Ready,
  stringArg,
  type ToolSpec,
} from "./tools-common";

type OwnedDomain = {
  domain: string;
  status?: string;
  expireDate?: string;
  autoRenew?: number | string;
  apiAccess?: number | string;
  whoisPrivacy?: number | string;
  securityLock?: number | string;
};

const PAGE = 1000;
/** A cap on pages, so a misbehaving answer cannot loop for ever. */
const MAX_PAGES = 20;

export async function listDomains(
  ready: Pick<Ready, "creds">,
  filter: Record<string, unknown> = {},
): Promise<{ domains: OwnedDomain[] } | { failure: string }> {
  const domains: OwnedDomain[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await psend(ready.creds, {
      method: "POST",
      path: "domain/listAll",
      body: { ...filter, start: page * PAGE },
    });
    if (!("ok" in answer)) return answer;
    const got = (answer.ok.body as { domains?: OwnedDomain[] }).domains;
    const batch = Array.isArray(got) ? got : [];
    domains.push(...batch);
    if (batch.length < PAGE) break;
  }
  return { domains };
}

const on = (flag: number | string | undefined) => flag === 1 || flag === "1";

/** `example.com | expires 2027-03-01 | auto-renew on | ACTIVE`, with a flag when the API cannot touch it. */
function domainLine(each: OwnedDomain): string {
  const parts = [
    each.domain,
    `expires ${each.expireDate ?? "?"}`,
    `auto-renew ${on(each.autoRenew) ? "on" : "off"}`,
    each.status ?? "?",
  ];
  if (!on(each.apiAccess)) parts.push("API access off (turn it on in Porkbun to change its DNS)");
  return parts.join(" | ");
}

async function runDomains(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const contains = stringArg(args, "contains");
  const within = intArg(args, "expiringWithinDays");
  const answer = await listDomains(ready, {
    ...(contains === undefined ? {} : { nameContains: contains }),
    ...(within === undefined ? {} : { expiringWithinDays: within }),
  });
  if ("failure" in answer) return answer.failure;
  if (answer.domains.length === 0) return "No domains in the Porkbun account match.";
  // Soonest expiry first (dates are `YYYY-MM-DD HH:MM:SS`, so text order is date order); no date last.
  const soonest = [...answer.domains].sort((a, b) =>
    (a.expireDate ?? "￿").localeCompare(b.expireDate ?? "￿"),
  );
  return fitText(soonest.map(domainLine).join("\n"), ready, "porkbun-domains");
}

export const domainsTool: ToolSpec = {
  name: "porkbun_domains",
  description:
    "The domains in the Porkbun account, soonest expiry first, one per line: expiry date, auto-renew, status. Read-only.",
  properties: {
    contains: { type: "string", description: "Only domains whose name contains this text." },
    expiringWithinDays: {
      type: "number",
      description: "Only domains expiring within this many days.",
    },
  },
  run: runDomains,
};

// ---- check

type Check = {
  avail?: string;
  price?: string;
  regularPrice?: string;
  firstYearPromo?: string;
  premium?: string;
  minDuration?: number;
  inYourAccount?: boolean;
  additional?: { renewal?: { price?: string } };
};

const dollars = (price: string | undefined) => (price === undefined ? "?" : `$${price}`);

/** `prifly.app: available, $11.08 a year, renews at $15.20`, or why it is not. */
function checkLine(name: string, each: Check): string {
  if (each.inYourAccount === true) return `${name}: already in your account`;
  if (each.avail !== "yes") return `${name}: taken`;
  const promo =
    each.firstYearPromo === "yes" ? ` first-year promo, regular ${dollars(each.regularPrice)}` : "";
  const renewal = each.additional?.renewal?.price;
  const years =
    each.minDuration !== undefined && each.minDuration > 1
      ? ` for ${each.minDuration} years`
      : " a year";
  const parts = [`${name}: available, ${dollars(each.price)}${years}${promo}`];
  if (renewal !== undefined) parts.push(`renews at ${dollars(renewal)}`);
  if (each.premium === "yes")
    parts.push("premium (Porkbun does not register premium names through the API)");
  return parts.join(", ");
}

function namesOf(args: Record<string, unknown>): string[] | { refusal: string } {
  const given = [args["domains"], args["domain"]].flat().filter((each) => typeof each === "string");
  const names: string[] = [];
  for (const each of given as string[]) {
    const name = cleanDomain(each);
    if (name === null) return { refusal: `${NOT_A_DOMAIN} (${each.trim().slice(0, 80)})` };
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0)
    return { refusal: 'Give `domains`: the names to check, like ["prifly.app"].' };
  return names.length > 25 ? { refusal: "At most 25 names in one check." } : names;
}

async function runCheck(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const names = namesOf(args);
  if ("refusal" in names) return names.refusal;
  // One name has its own endpoint; several go in one call to the bulk form of it.
  const [single] = names;
  const one = names.length === 1 && single !== undefined;
  const answer = orSentence(
    await psend(ready.creds, {
      method: "POST",
      path: one ? `domain/checkDomain/${encodeURIComponent(single)}` : "domain/checkDomain",
      body: one ? {} : { domains: names },
    }),
  );
  if ("sentence" in answer) return answer.sentence;
  const body = answer.value.body as {
    response?: Check;
    domains?: Record<string, Check>;
    unresolved?: string[];
    invalid?: unknown[];
  };
  const found: Record<string, Check> =
    one && single !== undefined ? { [single]: body.response ?? {} } : (body.domains ?? {});
  const lines = names
    .filter((name) => found[name] !== undefined)
    .map((name) => checkLine(name, found[name] ?? {}));
  for (const name of body.unresolved ?? [])
    lines.push(`${name}: the registry did not answer; ask again`);
  for (const entry of body.invalid ?? []) lines.push(`Not checkable: ${JSON.stringify(entry)}`);
  return lines.join("\n");
}

export const checkTool: ToolSpec = {
  name: "porkbun_check",
  description:
    "Whether domain names are free to register at Porkbun, with the price in US dollars (registration, and renewal). Up to 25 names. Read-only; buying one is a porkbun_api call to domain/create.",
  properties: {
    domains: {
      type: "array",
      items: { type: "string" },
      description: 'The names to check, e.g. ["prifly.app", "prifly.dev"].',
    },
  },
  required: ["domains"],
  run: runCheck,
};
