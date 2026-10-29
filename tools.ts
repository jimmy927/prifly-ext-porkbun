/**
 * The MCP tools every session sees as `mcp__prifly__porkbun_*`: reads for
 * domains, DNS records and availability, and the two that change things
 * (`porkbun_dns_change`, and the generic `porkbun_api`). Reads run at once;
 * every write asks the reader first (`write.ts`).
 */

import type { ExtensionApi, ExtensionTool } from "@prifly/extension-api";
import { apiTool } from "./tools-api";
import { makeTool } from "./tools-common";
import { dnsChangeTool, dnsRecordsTool } from "./tools-dns";
import { checkTool, domainsTool } from "./tools-domains";

export function porkbunTools(api: () => ExtensionApi | null): ExtensionTool[] {
  const specs = [domainsTool, dnsRecordsTool, checkTool, dnsChangeTool, apiTool];
  return specs.map((spec) => makeTool(api, spec));
}
