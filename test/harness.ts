/**
 * The tools registered on a fake api (a vault with the keys, unless left
 * out) over a fake Porkbun. Call `restoreFetch` from `afterEach`.
 */

import { porkbunTools } from "../tools";
import { type FakeApi, fakeApi } from "./fake-api";
import { type Call, installFetch, type Route, TOKEN } from "./porkbun-fake";

export function setup(
  routes: Route[],
  options: { vault?: string | null; confirm?: boolean | null; scratchpad?: string } = {},
): { fake: FakeApi; calls: Call[] } {
  const calls = installFetch(routes);
  const fake = fakeApi({
    vault: options.vault === undefined ? TOKEN : options.vault,
    ...(options.confirm === undefined ? {} : { confirm: options.confirm }),
    ...(options.scratchpad === undefined ? {} : { scratchpad: options.scratchpad }),
  });
  fake.api.tools?.register(porkbunTools(() => fake.api));
  return { fake, calls };
}
