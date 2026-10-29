/**
 * DNS: `porkbun_dns_records` (read) and `porkbun_dns_change` (create, edit or
 * delete one record, after the reader confirms). Porkbun names a record by a
 * numeric id, so an edit or delete first reads the domain's records and finds
 * the one meant, by `id` or by name + type; two matches is a question for the
 * session, never a guess.
 */

import { enc, psend, type Result, warningsOf } from "./porkbun";
import { domainOf, intArg, orSentence, type Ready, stringArg, type ToolSpec } from "./tools-common";
import { confirmedSend } from "./write";

export type DnsRecord = {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl?: string;
  prio?: string | null;
  notes?: string | null;
};

/** The name Porkbun wants in a body: relative to the domain, "" for the apex. */
export function subOf(name: string, domain: string): string {
  const text = name.trim().toLowerCase().replace(/\.$/, "");
  if (text === "@" || text === "" || text === domain) return "";
  return text.endsWith(`.${domain}`) ? text.slice(0, -(domain.length + 1)) : text;
}

/** `www.example.com`, or `example.com` for the apex. */
export function fullName(sub: string, domain: string): string {
  return sub === "" ? domain : `${sub}.${domain}`;
}

async function fetchRecords(ready: Ready, domain: string): Promise<Result<DnsRecord[]>> {
  const answer = await psend(ready.creds, { method: "POST", path: `dns/retrieve/${enc(domain)}` });
  if (!("ok" in answer)) return answer;
  const records = (answer.ok.body as { records?: DnsRecord[] }).records;
  return { ok: Array.isArray(records) ? records : [] };
}

function recordLine(each: DnsRecord): string {
  const prio =
    each.prio === null || each.prio === undefined || each.prio === "" ? "" : ` prio ${each.prio}`;
  const notes =
    each.notes === null || each.notes === undefined || each.notes === "" ? "" : ` (${each.notes})`;
  return `id ${each.id} | ${each.name} ${each.type} ${each.ttl ?? "?"}${prio} ${each.content}${notes}`;
}

// ---- records

async function runRecords(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const given = domainOf(args);
  if ("refusal" in given) return given.refusal;
  const name = stringArg(args, "name");
  const type = stringArg(args, "type")?.toUpperCase();
  const answer = orSentence(await fetchRecords(ready, given.domain));
  if ("sentence" in answer) return answer.sentence;
  const wanted = name === undefined ? undefined : fullName(subOf(name, given.domain), given.domain);
  const records = answer.value.filter(
    (each) =>
      (type === undefined || each.type.toUpperCase() === type) &&
      (wanted === undefined || each.name.toLowerCase() === wanted),
  );
  if (records.length === 0) return `No DNS records in ${given.domain} match.`;
  return records.map(recordLine).join("\n");
}

export const dnsRecordsTool: ToolSpec = {
  name: "porkbun_dns_records",
  description:
    "A Porkbun domain's DNS records, one per line: id, name, type, TTL, priority, content. Optional filter by name and type. Porkbun's default NS and SOA records are not included. Read-only.",
  properties: {
    domain: {
      type: "string",
      description: "The domain, like example.com (porkbun_domains lists yours).",
    },
    name: {
      type: "string",
      description: "Only this name: www, www.example.com, or @ (the domain itself).",
    },
    type: { type: "string", description: "Only this type, e.g. A, CNAME, TXT, MX." },
  },
  required: ["domain"],
  run: runRecords,
};

// ---- change

const ACTIONS = ["create", "edit", "delete"] as const;
type Action = (typeof ACTIONS)[number];

type ChangeInput = {
  action: Action;
  domain: string;
  /** Relative to the domain; "" is the apex. */
  sub: string;
  /** Whether the reader named a record by name (`name` was given). */
  named: boolean;
  type?: string;
  id?: string;
  content?: string;
  ttl?: number;
  prio?: number;
  notes?: string;
};

function inputOf(args: Record<string, unknown>): ChangeInput | { refusal: string } {
  const action = stringArg(args, "action") as Action | undefined;
  if (action === undefined || !ACTIONS.includes(action))
    return { refusal: "`action` is create, edit or delete." };
  const given = domainOf(args);
  if ("refusal" in given) return given;
  const name = stringArg(args, "name");
  const type = stringArg(args, "type")?.toUpperCase();
  const id =
    stringArg(args, "id") ?? (typeof args["id"] === "number" ? String(args["id"]) : undefined);
  const content = stringArg(args, "content");
  const input: ChangeInput = {
    action,
    domain: given.domain,
    sub: subOf(name ?? "@", given.domain),
    named: name !== undefined,
    ...(type === undefined ? {} : { type }),
    ...(id === undefined ? {} : { id }),
    ...(content === undefined ? {} : { content }),
    ...(intArg(args, "ttl") === undefined ? {} : { ttl: intArg(args, "ttl") as number }),
    ...(intArg(args, "prio") === undefined ? {} : { prio: intArg(args, "prio") as number }),
    ...(typeof args["notes"] === "string" ? { notes: args["notes"] } : {}),
  };
  return checked(input);
}

/** The input once it has what its action needs, or the one sentence that says what is missing. */
function checked(input: ChangeInput): ChangeInput | { refusal: string } {
  if (input.action === "create") {
    if (input.type === undefined || input.content === undefined)
      return {
        refusal:
          "Give `type` and `content` (the record's value, e.g. 1.2.3.4); `name` is www, @ for the domain itself.",
      };
    return input;
  }
  if (input.id === undefined && (!input.named || input.type === undefined))
    return {
      refusal: "Name the record: its `id` (porkbun_dns_records shows it), or `name` and `type`.",
    };
  const changes = [input.content, input.ttl, input.prio, input.notes];
  if (input.action === "edit" && changes.every((each) => each === undefined))
    return { refusal: "Give what to change: `content`, `ttl`, `prio` or `notes`." };
  return input;
}

/** The one record an edit or delete means, or the sentence saying why it is not one. */
async function findRecord(ready: Ready, input: ChangeInput): Promise<DnsRecord | string> {
  const all = orSentence(await fetchRecords(ready, input.domain));
  if ("sentence" in all)
    return `Could not read the records of ${input.domain} to change one: ${all.sentence}`;
  const wanted = fullName(input.sub, input.domain);
  const matches = all.value.filter((each) =>
    input.id === undefined
      ? each.name.toLowerCase() === wanted && each.type.toUpperCase() === input.type
      : each.id === input.id,
  );
  const [only, ...more] = matches;
  if (only === undefined)
    return input.id === undefined
      ? `No ${input.type} record named ${wanted} in ${input.domain}.`
      : `No record with id ${input.id} in ${input.domain}.`;
  if (more.length > 0)
    return `${matches.length} records match; pass the \`id\` of the one meant:\n${matches.map(recordLine).join("\n")}`;
  return only;
}

/** "an A", "a CNAME": by how the type's first letter is said aloud. */
function withArticle(type: string): string {
  return `${/^[AEFHILMNORSX]/.test(type) ? "an" : "a"} ${type}`;
}

type Shape = { name: string; type: string; content: string };

/** `an A record for www.example.com pointing to 1.2.3.4`, a part of a sentence. */
function recordPhrase(each: Shape): string {
  const link = ["A", "AAAA", "CNAME", "ALIAS"].includes(each.type.toUpperCase())
    ? "pointing to"
    : "with data";
  return `${withArticle(each.type.toUpperCase())} record for ${each.name} ${link} ${each.content}`;
}

type Block = Shape & {
  ttl?: string | number | undefined;
  prio?: string | number | null | undefined;
  notes?: string | null | undefined;
};

function recordBlock(each: Block): string {
  const lines = [`Name: ${each.name}`, `Type: ${each.type.toUpperCase()}`];
  lines.push(
    `TTL: ${each.ttl === undefined ? "Porkbun's default for the account" : `${each.ttl} seconds`}`,
  );
  if (each.prio !== undefined && each.prio !== null && each.prio !== "" && each.prio !== "0")
    lines.push(`Priority: ${each.prio}`);
  lines.push(`Value: ${each.content}`);
  if (each.notes !== undefined && each.notes !== null && each.notes !== "")
    lines.push(`Notes: ${each.notes}`);
  return lines.join("\n");
}

/** The request, the title and the card's words for one change. */
export type Plan = {
  path: string;
  body?: unknown;
  title: string;
  summary: string;
  content: string;
};

/** What goes out and what the card says, for a create. */
function createPlan(input: ChangeInput): Plan {
  const name = fullName(input.sub, input.domain);
  const type = input.type ?? "";
  const content = input.content ?? "";
  const shown: Block = {
    name,
    type,
    content,
    ttl: input.ttl,
    prio: input.prio,
    notes: input.notes,
  };
  return {
    path: `dns/create/${enc(input.domain)}`,
    body: {
      name: input.sub,
      type,
      content,
      ...(input.ttl === undefined ? {} : { ttl: input.ttl }),
      ...(input.prio === undefined ? {} : { prio: input.prio }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    },
    title: "Add a DNS record",
    summary: `Add ${recordPhrase({ name, type, content })} in ${input.domain}.`,
    content: `Domain: ${input.domain}\n\nNew record\n${recordBlock(shown)}`,
  };
}

function deletePlan(input: ChangeInput, existing: DnsRecord): Plan {
  return {
    path: `dns/delete/${enc(input.domain)}/${enc(existing.id)}`,
    title: "Delete a DNS record",
    summary: `Delete ${recordPhrase(existing)} from ${input.domain}.`,
    content: `Domain: ${input.domain}\n\nRecord to delete\n${recordBlock(existing)}`,
  };
}

/** An edit sends only what the reader asked to change; the card shows the record before and after. */
function editPlan(input: ChangeInput, existing: DnsRecord): Plan {
  const after: Block = {
    ...existing,
    content: input.content ?? existing.content,
    ttl: input.ttl ?? existing.ttl,
    prio: input.prio ?? existing.prio,
    notes: input.notes ?? existing.notes,
  };
  return {
    path: `dns/edit/${enc(input.domain)}/${enc(existing.id)}`,
    body: {
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.ttl === undefined ? {} : { ttl: input.ttl }),
      ...(input.prio === undefined ? {} : { prio: input.prio }),
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    },
    title: "Change a DNS record",
    summary: `In ${input.domain}, replace ${recordPhrase(existing)} with ${recordPhrase(after)}.`,
    content: `Domain: ${input.domain}\n\nCurrent record (replaced)\n${recordBlock(existing)}\n\nNew record\n${recordBlock(after)}`,
  };
}

async function runChange(ready: Ready, args: Record<string, unknown>): Promise<string> {
  const input = inputOf(args);
  if ("refusal" in input) return input.refusal;
  let plan: Plan;
  if (input.action === "create") {
    plan = createPlan(input);
  } else {
    const existing = await findRecord(ready, input);
    if (typeof existing === "string") return existing;
    plan = input.action === "delete" ? deletePlan(input, existing) : editPlan(input, existing);
  }
  const answer = await confirmedSend(ready, { method: "POST", ...plan });
  if ("cancelled" in answer) return answer.cancelled;
  const result = orSentence(answer);
  if ("sentence" in result) return result.sentence;
  const id = (result.value.body as { id?: string | number }).id;
  return `Porkbun accepted it${id === undefined ? "" : ` (record ${id})`}: ${plan.summary}${warningsOf(result.value.body)}`;
}

export const dnsChangeTool: ToolSpec = {
  name: "porkbun_dns_change",
  description:
    "Create, edit or delete one Porkbun DNS record. Shows the reader a confirm card with the exact change first; nothing changes if they cancel. An edit or delete names the record by `id`, or by `name` + `type` when exactly one matches.",
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "create, edit or delete." },
    domain: { type: "string", description: "The domain, like example.com." },
    name: {
      type: "string",
      description:
        "The record's name: www, www.example.com or @ (the domain itself). create: left out means the domain itself.",
    },
    type: {
      type: "string",
      description: "Record type: A, AAAA, CNAME, ALIAS, TXT, MX, NS, SRV, CAA, ...",
    },
    id: {
      type: "string",
      description: "edit/delete: the record's id from porkbun_dns_records, instead of name + type.",
    },
    content: {
      type: "string",
      description: "create/edit: the record's value, e.g. 1.2.3.4; TXT text as it is.",
    },
    ttl: {
      type: "number",
      description: "create/edit: TTL in seconds (Porkbun's minimum is usually 600).",
    },
    prio: { type: "number", description: "create/edit: priority for MX and SRV records." },
    notes: {
      type: "string",
      description: "create/edit: a note kept with the record (not served in DNS).",
    },
  },
  required: ["action", "domain"],
  run: runChange,
};
