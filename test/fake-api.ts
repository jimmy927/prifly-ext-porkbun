/**
 * A fake of prifly's `api`, for this extension's own tests: the tools it
 * registers, the vault, every confirm card and status line it is given, and
 * every log line are kept to look at. Only the parts the extension uses are
 * there, so the object is cast to `ExtensionApi` once, here.
 */

import type {
  ConfirmSpec,
  ExtensionApi,
  ExtensionTool,
  ExtensionToolContext,
} from "@prifly/extension-api";

export type FakeApi = {
  api: ExtensionApi;
  tools: () => ExtensionTool[];
  /** Calls one registered tool the way a session would. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Every confirm card asked for, in order. */
  confirms: ConfirmSpec[];
  statuses: string[];
  logs: { event: string; fields: Record<string, unknown> | undefined }[];
};

export function fakeApi(
  options: {
    /** The token of the vault entry `porkbun`; null is no entry. */
    vault?: string | null;
    /** What the reader answers on a confirm card; null leaves `api.confirm` out (an older prifly). */
    confirm?: boolean | null;
    scratchpad?: string;
  } = {},
): FakeApi {
  let tools: ExtensionTool[] = [];
  const confirms: ConfirmSpec[] = [];
  const statuses: string[] = [];
  const logs: FakeApi["logs"] = [];
  const answer = options.confirm === undefined ? true : options.confirm;
  const vault = options.vault === undefined ? null : options.vault;
  const api = {
    features: ["confirm", "status"],
    tools: {
      register: (given: ExtensionTool[]) => {
        tools = given;
      },
    },
    vault: { read: async (name: string) => (name === "porkbun" ? vault : null) },
    log: (event: string, fields?: Record<string, unknown>) => void logs.push({ event, fields }),
    status: (text: string) => void statuses.push(text),
    folder: process.cwd(),
    ...(answer === null
      ? {}
      : {
          confirm: async (spec: ConfirmSpec) => {
            confirms.push(spec);
            return answer;
          },
        }),
  } as unknown as ExtensionApi;
  const callTool: FakeApi["callTool"] = (name, args) => {
    const tool = tools.find((each) => each.name === name);
    if (tool === undefined) throw new Error(`No tool ${name} registered`);
    const ctx = {
      session: "fake-session",
      pick: async () => null,
      signal: new AbortController().signal,
      ...(options.scratchpad === undefined ? {} : { scratchpad: options.scratchpad }),
    };
    return tool.call(args, ctx as unknown as ExtensionToolContext);
  };
  return { api, tools: () => tools, callTool, confirms, statuses, logs };
}
