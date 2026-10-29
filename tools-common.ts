/**
 * What every `porkbun_*` tool does first: find the keys in the vault (or say
 * what to add). A tool then only builds its request and words the answer; a
 * write goes through `write.ts`, which asks the reader first.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionApi, ExtensionTool, ExtensionToolContext } from "@prifly/extension-api";
import { type Creds, readCreds } from "./credentials";
import type { Failure } from "./porkbun";

/** What a tool body gets once the keys are in hand. */
export type Ready = {
  api: ExtensionApi;
  creds: Creds;
  ctx: ExtensionToolContext;
};

export type ToolSpec = {
  name: string;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
  run: (ready: Ready, args: Record<string, unknown>) => Promise<string>;
};

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** A whole number >= 0 given as a number or a numeric string; undefined when absent or not one. */
export function intArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 0 ? number : undefined;
}

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9][a-z0-9-]*$/;

/** A domain as Porkbun wants it: lower case, no trailing dot; null when it is not a domain name. */
export function cleanDomain(text: string): string | null {
  const domain = text.trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN.test(domain) ? domain : null;
}

export const NOT_A_DOMAIN = "That is not a domain name (like example.com).";

/** The `domain` argument cleaned, or why it cannot be used. */
export function domainOf(args: Record<string, unknown>): { domain: string } | { refusal: string } {
  const given = stringArg(args, "domain");
  if (given === undefined)
    return { refusal: "Give `domain`: like example.com (porkbun_domains lists yours)." };
  const domain = cleanDomain(given);
  return domain === null ? { refusal: NOT_A_DOMAIN } : { domain };
}

export function makeTool(apiOf: () => ExtensionApi | null, spec: ToolSpec): ExtensionTool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: {
      type: "object",
      properties: spec.properties,
      ...(spec.required === undefined ? {} : { required: spec.required }),
      additionalProperties: false,
    },
    async call(args, ctx) {
      const api = apiOf();
      if (api === null) return "The Porkbun extension is not ready yet; try again shortly.";
      const found = await readCreds(api);
      if ("refusal" in found) return found.refusal;
      return await spec.run({ api, creds: found.creds, ctx }, args);
    },
  };
}

/** Unwrap a `Result` into either its value or the failure's one sentence. */
export function orSentence<T>(answer: { ok: T } | Failure): { value: T } | { sentence: string } {
  return "ok" in answer ? { value: answer.ok } : { sentence: answer.failure };
}

/** The most a tool answers in its own text; the rest goes to the session's scratchpad. */
export const MAX_ANSWER = 20_000;

/**
 * `text` when it fits; else its start, and the whole of it saved as
 * `<label>-<time>.txt` in the session's scratchpad (said where), or how much
 * was cut when the session has none.
 */
export function fitText(text: string, ready: Ready, label: string): string {
  if (text.length <= MAX_ANSWER) return text;
  const head = text.slice(0, MAX_ANSWER);
  const cut = text.length - MAX_ANSWER;
  const scratchpad = scratchpadOf(ready.ctx);
  if (scratchpad === undefined) {
    return `${head}\n(${cut} more characters cut: the answer was too long and this session has no scratchpad. Ask for less: a filter or a smaller page.)`;
  }
  mkdirSync(scratchpad, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(scratchpad, `${label.replace(/[^a-z0-9-]/gi, "-")}-${stamp}.txt`);
  writeFileSync(file, text);
  return `${head}\n(${cut} more characters cut: the whole answer is in ${file})`;
}

/** `ctx.scratchpad`, which throws on a prifly that cannot find the session's folder. */
function scratchpadOf(ctx: ExtensionToolContext): string | undefined {
  try {
    return ctx.scratchpad;
  } catch {
    return undefined;
  }
}
