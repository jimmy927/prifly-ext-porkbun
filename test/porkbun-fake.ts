/**
 * A fake Porkbun for `fetch`: `installFetch(routes)` replaces the global
 * `fetch` (call `restoreFetch` from `afterEach`), records every request, and
 * answers from the first route that matches. A request no route matches is
 * answered with a Porkbun-style error, so a test that expects none sent can
 * look at `calls` instead. The real API is never called.
 */

export type Call = {
  method: string;
  url: string;
  /** The path after `/api/json/v3/`, query left off. */
  path: string;
  headers: Record<string, string>;
  /** The parsed JSON body; undefined when there was none. */
  body: unknown;
};

export type Route = {
  method?: string;
  path: RegExp;
  answer: (call: Call) => Response;
};

export const KEY = "pk1_testkey000001";
export const SECRET = "sk1_testsecret0002";
/** What the vault holds in the tests: both keys as one JSON token. */
export const TOKEN = JSON.stringify({ apikey: KEY, secretapikey: SECRET });

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function porkbunError(message: string, code: string, status = 400): Response {
  return json({ status: "ERROR", message, code }, status);
}

const realFetch = globalThis.fetch;

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

export function installFetch(routes: Route[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const text = typeof init?.body === "string" ? init.body : undefined;
    const parsed = new URL(url);
    const call: Call = {
      method,
      url,
      path: parsed.pathname.replace(/^\/api\/json\/v3\//, ""),
      headers,
      body: text === undefined ? undefined : JSON.parse(text),
    };
    calls.push(call);
    const route = routes.find(
      (each) => (each.method === undefined || each.method === method) && each.path.test(call.path),
    );
    return route === undefined
      ? porkbunError(`No fake route for ${method} ${call.path}`, "NO_ROUTE", 404)
      : route.answer(call);
  }) as typeof fetch;
  return calls;
}
