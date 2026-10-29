/**
 * The Porkbun extension: what prifly imports. A toolbox for prompts:
 * `activate` registers the `porkbun_*` tools and keeps one status line in
 * Settings → Extensions. No launcher, board, chip or panel. The session
 * instructions are `prompt.md` (the manifest's `prompt`). Types come from
 * `@prifly/extension-api` with `import type`, so nothing of it is loaded at
 * run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { startStatus } from "./status";
import { porkbunTools } from "./tools";

export function activate(given: ExtensionApi): () => void {
  let api: ExtensionApi | null = given;
  const status = startStatus(given);
  given.tools?.register(porkbunTools(() => api));
  given.log("activated", {});
  return () => {
    status.stop();
    api = null;
  };
}
