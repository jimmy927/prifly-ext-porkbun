import { afterEach, describe, expect, test } from "bun:test";
import { cleanPath, isRead, describe as words } from "../tools-api";
import { CANCELLED } from "../write";
import { setup } from "./harness";
import { json, KEY, porkbunError, type Route, restoreFetch, SECRET } from "./porkbun-fake";

afterEach(restoreFetch);

const ok =
  (extra: Record<string, unknown> = {}): Route["answer"] =>
  () =>
    json({ status: "SUCCESS", ...extra });

const ROUTES: Route[] = [
  {
    path: /^domain\/getNs\//,
    answer: ok({ ns: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"] }),
  },
  { path: /^domain\/listAll$/, answer: ok({ domains: [] }) },
  { path: /^domain\/create\//, answer: ok({ domain: "prifly.app", cost: 1108, balance: 5000 }) },
  { path: /^domain\/updateNs\//, answer: ok() },
  { path: /^domain\/updateAutoRenew\//, answer: ok({ results: {} }) },
  { path: /^ssl\/retrieve\//, answer: ok({ certificatechain: "-----BEGIN CERTIFICATE-----" }) },
];

describe("what counts as a read", () => {
  test("GETs and the lookup POSTs read; purchases and changes do not", () => {
    expect(isRead("GET", "domain/getNs/prifly.dev")).toBe(true);
    expect(isRead("GET", "account/balance")).toBe(true);
    expect(isRead("POST", "domain/listAll")).toBe(true);
    expect(isRead("POST", "dns/retrieve/prifly.dev")).toBe(true);
    expect(isRead("POST", "domain/checkDomain/prifly.app")).toBe(true);
    expect(isRead("POST", "pricing/get")).toBe(true);
    expect(isRead("POST", "domain/create/prifly.app")).toBe(false);
    expect(isRead("POST", "domain/updateNs/prifly.dev")).toBe(false);
    expect(isRead("POST", "dns/delete/prifly.dev/1")).toBe(false);
    expect(isRead("POST", "account/topup")).toBe(false);
    // Looks like a read by its start, is not one.
    expect(isRead("POST", "domain/listAllAndDelete")).toBe(false);
    // The certificate's private key: shown to the reader first, GET or not.
    expect(isRead("GET", "ssl/retrieve/prifly.dev")).toBe(false);
    expect(isRead("POST", "ssl/retrieve/prifly.dev")).toBe(false);
  });

  test("a path is the part after /api/json/v3/ and nothing else", () => {
    expect(cleanPath("/domain/getNs/prifly.dev")).toBe("domain/getNs/prifly.dev");
    expect(cleanPath("/api/json/v3/ping")).toBe("ping");
    for (const bad of ["https://evil.example/x", "../x", "a/../b", "a?b=1", "", "a b"])
      expect(cleanPath(bad)).toBeNull();
  });
});

describe("porkbun_api reads", () => {
  test("a GET runs at once, signed by headers, with no body and no card", async () => {
    const { fake, calls } = setup(ROUTES);
    const text = await fake.callTool("porkbun_api", {
      method: "GET",
      path: "domain/getNs/prifly.dev",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toBe("https://api.porkbun.com/api/json/v3/domain/getNs/prifly.dev");
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(calls[0]?.headers["x-secret-api-key"]).toBe(SECRET);
    expect(JSON.parse(text)).toEqual({
      status: "SUCCESS",
      ns: ["curitiba.ns.porkbun.com", "fortaleza.ns.porkbun.com"],
    });
    expect(fake.confirms).toHaveLength(0);
  });

  test("query parameters go on the URL", async () => {
    const { fake, calls } = setup(ROUTES);
    await fake.callTool("porkbun_api", {
      method: "GET",
      path: "domain/listAll",
      query: { nameContains: "prifly", start: 0 },
    });
    expect(new URL(calls[0]?.url ?? "").search).toBe("?nameContains=prifly&start=0");
  });

  test("a POST read sends the body without any key the session put in it", async () => {
    const { fake, calls } = setup(ROUTES);
    await fake.callTool("porkbun_api", {
      method: "POST",
      path: "domain/listAll",
      body: { apikey: KEY, secretapikey: SECRET, nameContains: "prifly" },
    });
    expect(calls[0]?.body).toEqual({ nameContains: "prifly" });
    expect(fake.confirms).toHaveLength(0);
  });

  test("an unusable method, path or body is refused before any request", async () => {
    const { fake, calls } = setup(ROUTES);
    expect(await fake.callTool("porkbun_api", { method: "DELETE", path: "x" })).toContain(
      "GET or POST",
    );
    expect(
      await fake.callTool("porkbun_api", { method: "GET", path: "https://evil.example/ping" }),
    ).toContain("after /api/json/v3/");
    expect(
      await fake.callTool("porkbun_api", { method: "POST", path: "ping", body: [1] }),
    ).toContain("JSON object");
    expect(calls).toHaveLength(0);
  });
});

describe("porkbun_api purchases", () => {
  const buy = {
    method: "POST",
    path: "domain/create/prifly.app",
    body: { cost: 1108, agreeToTerms: "yes" },
  };

  test("domain/create: the card shows dollars, the request sends pennies", async () => {
    const { fake, calls } = setup(ROUTES);
    const text = await fake.callTool("porkbun_api", {
      ...buy,
      body: { ...buy.body, apikey: KEY, secretapikey: SECRET },
    });
    const card = fake.confirms[0];
    expect(fake.confirms).toHaveLength(1);
    expect(card?.title).toBe("Register a domain");
    expect(card?.summary).toBe(
      "Register prifly.app for $11.08, taken from your Porkbun account credit.",
    );
    expect(card?.summary).not.toMatch(/https?:|[{}\n]/);
    expect(card?.content).toBe("Call: domain/create/prifly.app\nCost: $11.08 (sent as 1108 cents)");
    expect(card?.details).toContain(
      "POST https://api.porkbun.com/api/json/v3/domain/create/prifly.app",
    );
    expect(card?.details).toContain('"cost": 1108');
    // The keys the session wrote into the body are on neither the card nor the wire.
    for (const shown of [card?.summary, card?.content, card?.details])
      expect(`${shown}`).not.toMatch(new RegExp(`${KEY}|${SECRET}`));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ cost: 1108, agreeToTerms: "yes" });
    expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
    expect(text).toContain("Porkbun accepted it: Register prifly.app for $11.08");
    expect(text).toContain('"balance": 5000');
  });

  test("paying by card or USDC is said on the card; a dry run says nothing is bought", async () => {
    const { fake } = setup(ROUTES);
    await fake.callTool("porkbun_api", {
      ...buy,
      body: { cost: 1108, agreeToTerms: "yes", payWith: "card", dryRun: true },
    });
    expect(fake.confirms[0]?.summary).toBe("Register prifly.app for $11.08, paid by card.");
    expect(fake.confirms[0]?.content).toContain(
      "Dry run: Porkbun only checks; nothing is bought or changed.",
    );
    expect(words("domain/renew/prifly.app", { cost: 1520, payWith: "usdc" }).summary).toBe(
      "Renew prifly.app for $15.20, paid in USDC.",
    );
  });

  test("a cost that is not whole pennies is refused before any card", async () => {
    const { fake, calls } = setup(ROUTES);
    const text = await fake.callTool("porkbun_api", {
      ...buy,
      body: { cost: 11.08, agreeToTerms: "yes" },
    });
    expect(text).toContain("`cost` is in US cents");
    expect(fake.confirms).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("cancelled: the purchase is never sent", async () => {
    const { fake, calls } = setup(ROUTES, { confirm: false });
    const text = await fake.callTool("porkbun_api", buy);
    expect(text).toBe(CANCELLED);
    expect(text).toBe("Not done: you cancelled");
    expect(fake.confirms).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("Porkbun's refusal comes back readably, with its own answer under it", async () => {
    const { fake } = setup([
      {
        path: /^domain\/create\//,
        answer: () =>
          json(
            {
              status: "ERROR",
              message: "Insufficient funds. Cost 1108, balance 200.",
              code: "INSUFFICIENT_FUNDS",
              shortfall: 908,
            },
            402,
          ),
      },
    ]);
    const text = await fake.callTool("porkbun_api", buy);
    expect(text.split("\n")[0]).toBe(
      "Porkbun error: Insufficient funds. Cost 1108, balance 200. (INSUFFICIENT_FUNDS)",
    );
    expect(text).toContain('"shortfall": 908');
  });

  test("a plain error with no body of its own is still readable", async () => {
    const { fake } = setup([
      {
        path: /^domain\/create\//,
        answer: () => porkbunError("Domain is not available.", "DOMAIN_NOT_AVAILABLE"),
      },
    ]);
    expect((await fake.callTool("porkbun_api", buy)).split("\n")[0]).toBe(
      "Porkbun error: Domain is not available. (DOMAIN_NOT_AVAILABLE)",
    );
  });
});

describe("porkbun_api other changes", () => {
  test("nameservers", async () => {
    const { fake, calls } = setup(ROUTES);
    await fake.callTool("porkbun_api", {
      method: "POST",
      path: "domain/updateNs/prifly.dev",
      body: { ns: ["ns1.example.net", "ns2.example.net"] },
    });
    const card = fake.confirms[0];
    expect(card?.title).toBe("Change nameservers");
    expect(card?.summary).toBe(
      "Change the nameservers of prifly.dev to ns1.example.net, ns2.example.net.",
    );
    expect(calls[0]?.body).toEqual({ ns: ["ns1.example.net", "ns2.example.net"] });
  });

  test("auto-renew, and a call with no special wording", async () => {
    const { fake } = setup(ROUTES);
    await fake.callTool("porkbun_api", {
      method: "POST",
      path: "domain/updateAutoRenew/prifly.dev",
      body: { status: "off" },
    });
    expect(fake.confirms[0]?.summary).toBe("Turn auto-renew off for prifly.dev.");
    expect(words("cloudflare/connect", {})).toEqual({
      title: "Change something at Porkbun",
      summary: "Make the Porkbun API call cloudflare/connect.",
    });
  });

  test("a GET that returns the certificate's private key still asks first", async () => {
    const { fake, calls } = setup(ROUTES, { confirm: false });
    expect(
      await fake.callTool("porkbun_api", { method: "GET", path: "ssl/retrieve/prifly.dev" }),
    ).toBe(CANCELLED);
    expect(fake.confirms[0]?.details).toContain(
      "GET https://api.porkbun.com/api/json/v3/ssl/retrieve/prifly.dev",
    );
    expect(calls).toHaveLength(0);
  });

  test("account top-up shows its amount in dollars", async () => {
    const { fake } = setup([{ path: /^account\/topup$/, answer: ok({ charged: 2500 }) }]);
    await fake.callTool("porkbun_api", {
      method: "POST",
      path: "account/topup",
      body: { amount: 2500 },
    });
    expect(fake.confirms[0]?.summary).toBe(
      "Charge your saved card $25.00 to add Porkbun account credit.",
    );
    expect(fake.confirms[0]?.content).toContain("Amount: $25.00 (sent as 2500 cents)");
  });
});
